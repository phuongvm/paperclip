import { readFileSync, statSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import type { AdapterConfigSchema, AdapterModel } from "@paperclipai/adapter-utils";
import {
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";
import { resolveHermesHome } from "./detect-model.js";

export interface HermesProviderEntry {
  id: string;
  label: string;
  baseUrlHost: string;
  keyEnv?: string;
  isUserDefined: boolean;
  models: string[];
}

export interface HermesCatalog {
  defaultProvider: string;
  defaultModel: string;
  defaultProviderReadable: boolean;
  hasNamedProviders: boolean;
  configuredProviders: string[];
  allowedProviders: string[];
  modelsByProvider: Record<string, string[]>;
  providers: HermesProviderEntry[];
}

export interface HermesProviderPolicy {
  mode: "restrictive" | "legacy";
  allowedProviders: Set<string>;
}

export interface CatalogIo {
  readFile?: (filePath: string) => string;
  stat?: (filePath: string) => { mtimeMs: number };
}

export function normalizeSlug(slug: string): string {
  return String(slug ?? "").trim().toLowerCase();
}

function stripInlineCommentAndQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  const withoutComment = trimmed.replace(/\s+#.*$/, "").trim();
  return withoutComment.replace(/^['"]|['"]$/g, "").trim();
}

function extractHost(urlStr: string): string {
  if (!urlStr) return "";
  try {
    return new URL(urlStr).host;
  } catch {
    return "";
  }
}

function isMalformedYamlContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.includes("\t")) return true;
    if (t.startsWith(":")) return true;
    const isListItem = /^-\s+.+$/.test(t) || t === "-";
    const isKeyVal = /^[^:#]+:(?:\s*.*)?$/.test(t);
    if (!isListItem && !isKeyVal) {
      return true;
    }
  }
  return false;
}

interface RawProviderBlock {
  rawSlug: string;
  name?: string;
  enabled: boolean;
  baseUrl?: string;
  keyEnv?: string;
  models: string[];
}

function parseYamlCatalogContent(content: string): {
  valid: boolean;
  defaultModel: string;
  defaultProvider: string;
  providerBlocks: RawProviderBlock[];
} {
  if (isMalformedYamlContent(content)) {
    return {
      valid: false,
      defaultModel: "",
      defaultProvider: "",
      providerBlocks: [],
    };
  }

  const lines = content.split(/\r?\n/);
  let topSection: "none" | "model" | "providers" | "custom_providers" = "none";
  let defaultModel = "";
  let defaultProvider = "";

  const providerBlocks: RawProviderBlock[] = [];
  let currentProvider: RawProviderBlock | null = null;
  let currentProviderIndent = -1;
  let inModelsSubsection = false;
  let modelsSubsectionIndent = -1;
  let modelEntryIndent: number | null = null;

  for (const rawLine of lines) {
    const trimmedRight = rawLine.replace(/\s+$/, "");
    const trimmed = trimmedRight.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      currentProvider = null;
      inModelsSubsection = false;
      modelEntryIndent = null;

      const rootMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!rootMatch) continue;
      const rootKey = rootMatch[1];
      if (rootKey === "model") {
        topSection = "model";
      } else if (rootKey === "providers") {
        topSection = "providers";
      } else if (rootKey === "custom_providers") {
        topSection = "custom_providers";
      } else {
        topSection = "none";
      }
      continue;
    }

    if (topSection === "model") {
      const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) {
        const key = m[1];
        const val = stripInlineCommentAndQuotes(m[2] ?? "");
        if (key === "default") defaultModel = val;
        if (key === "provider") defaultProvider = normalizeSlug(val);
      }
      continue;
    }

    if (topSection === "providers" || topSection === "custom_providers") {
      if (inModelsSubsection && indent <= modelsSubsectionIndent) {
        inModelsSubsection = false;
        modelEntryIndent = null;
      }

      if (
        currentProvider === null ||
        (indent === currentProviderIndent && !inModelsSubsection)
      ) {
        if (trimmed.startsWith("- ")) {
          const itemBody = trimmed.slice(2).trim();
          const kv = itemBody.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
          const initialSlug =
            kv && (kv[1] === "slug" || kv[1] === "id" || kv[1] === "name")
              ? stripInlineCommentAndQuotes(kv[2] ?? "")
              : "";
          currentProvider = {
            rawSlug: initialSlug,
            name: kv && kv[1] === "name" ? stripInlineCommentAndQuotes(kv[2] ?? "") : undefined,
            enabled: true,
            models: [],
          };
          currentProviderIndent = indent;
          providerBlocks.push(currentProvider);
          continue;
        }

        const pMatch = trimmed.match(/^([^:#]+?)\s*:\s*(.*)$/);
        if (pMatch && (currentProvider === null || indent === currentProviderIndent)) {
          const rawKey = stripInlineCommentAndQuotes(pMatch[1]);
          currentProvider = {
            rawSlug: rawKey,
            enabled: true,
            models: [],
          };
          currentProviderIndent = indent;
          providerBlocks.push(currentProvider);
          continue;
        }
      }

      if (!currentProvider) continue;

      if (inModelsSubsection) {
        if (trimmed.startsWith("-")) {
          const itemVal = trimmed.replace(/^-\s*/, "").trim();
          if (!itemVal) continue;
          const kv = itemVal.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
          const modelId =
            kv && (kv[1] === "id" || kv[1] === "name" || kv[1] === "model")
              ? stripInlineCommentAndQuotes(kv[2] ?? "")
              : stripInlineCommentAndQuotes(itemVal);
          if (modelId && !currentProvider.models.includes(modelId)) {
            currentProvider.models.push(modelId);
          }
          continue;
        }

        const dictMatch = trimmed.match(/^([^:#]+?)\s*:\s*(.*)$/);
        if (dictMatch) {
          if (modelEntryIndent === null || indent <= modelEntryIndent) {
            modelEntryIndent = indent;
            const modelId = stripInlineCommentAndQuotes(dictMatch[1]);
            if (modelId && !currentProvider.models.includes(modelId)) {
              currentProvider.models.push(modelId);
            }
          }
        }
        continue;
      }

      const propMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (propMatch) {
        const key = propMatch[1];
        const rawRest = propMatch[2] ?? "";
        const val = stripInlineCommentAndQuotes(rawRest);
        if (key === "models") {
          inModelsSubsection = true;
          modelsSubsectionIndent = indent;
          modelEntryIndent = null;
          if (val === "[]" || val === "{}") {
            inModelsSubsection = false;
          }
        } else if (key === "enabled") {
          currentProvider.enabled = val.toLowerCase() !== "false";
        } else if (key === "name" || key === "label") {
          if (val) currentProvider.name = val;
          if (!currentProvider.rawSlug && val) currentProvider.rawSlug = val;
        } else if (key === "slug" || key === "id") {
          if (val) currentProvider.rawSlug = val;
        } else if (key === "base_url" || key === "baseUrl") {
          currentProvider.baseUrl = val;
        } else if (key === "key_env" || key === "keyEnv") {
          currentProvider.keyEnv = val;
        }
      }
    }
  }

  return {
    valid: true,
    defaultModel,
    defaultProvider,
    providerBlocks,
  };
}

function buildHermesCatalogFromContent(
  content: string | null,
  env: NodeJS.ProcessEnv = process.env,
): HermesCatalog {
  if (content === null) {
    const emptyCatalog: HermesCatalog = {
      defaultProvider: "",
      defaultModel: "",
      defaultProviderReadable: false,
      hasNamedProviders: false,
      configuredProviders: [],
      allowedProviders: [],
      modelsByProvider: {},
      providers: [],
    };
    const policy = computePolicy(emptyCatalog, env);
    emptyCatalog.allowedProviders = Array.from(policy.allowedProviders);
    return emptyCatalog;
  }

  const parsed = parseYamlCatalogContent(content);
  if (!parsed.valid) {
    const invalidCatalog: HermesCatalog = {
      defaultProvider: "",
      defaultModel: "",
      defaultProviderReadable: false,
      hasNamedProviders: false,
      configuredProviders: [],
      allowedProviders: [],
      modelsByProvider: {},
      providers: [],
    };
    const policy = computePolicy(invalidCatalog, env);
    invalidCatalog.allowedProviders = Array.from(policy.allowedProviders);
    return invalidCatalog;
  }

  const providers: HermesProviderEntry[] = [];
  const configuredProviders: string[] = [];
  const modelsByProvider: Record<string, string[]> = {};

  for (const block of parsed.providerBlocks) {
    if (!block.enabled) continue;
    const slug = normalizeSlug(block.rawSlug);
    if (!slug || slug === "auto") continue;
    if (configuredProviders.includes(slug)) continue;

    configuredProviders.push(slug);
    const models = [...block.models];
    modelsByProvider[slug] = models;
    providers.push({
      id: slug,
      label: block.name?.trim() || slug,
      baseUrlHost: extractHost(block.baseUrl ?? ""),
      ...(block.keyEnv ? { keyEnv: block.keyEnv } : {}),
      isUserDefined: true,
      models,
    });
  }

  const catalog: HermesCatalog = {
    defaultProvider: parsed.defaultProvider,
    defaultModel: parsed.defaultModel,
    defaultProviderReadable: true,
    hasNamedProviders: configuredProviders.length > 0,
    configuredProviders,
    allowedProviders: [],
    modelsByProvider,
    providers,
  };

  const policy = computePolicy(catalog, env);
  catalog.allowedProviders = Array.from(policy.allowedProviders);
  return catalog;
}

interface CachedCatalogEntry {
  hermesHome: string;
  mtimeMs: number;
  catalog: HermesCatalog;
}

let catalogCache: CachedCatalogEntry | null = null;

export function parseHermesProvidersAndModels(
  hermesHome: string,
  io?: CatalogIo,
): HermesCatalog {
  const configPath = join(hermesHome, "config.yaml");
  const readFn = io?.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const statFn = io?.stat ?? ((p: string) => statSync(p));

  let mtimeMs: number | null = null;
  try {
    mtimeMs = statFn(configPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (
    !io &&
    mtimeMs !== null &&
    catalogCache &&
    catalogCache.hermesHome === hermesHome &&
    catalogCache.mtimeMs === mtimeMs
  ) {
    const cached = {
      ...catalogCache.catalog,
      configuredProviders: [...catalogCache.catalog.configuredProviders],
      modelsByProvider: { ...catalogCache.catalog.modelsByProvider },
      providers: catalogCache.catalog.providers.map((p) => ({
        ...p,
        models: [...p.models],
      })),
    };
    const policy = computePolicy(cached, process.env);
    cached.allowedProviders = Array.from(policy.allowedProviders);
    return cached;
  }

  let content: string | null = null;
  try {
    content = readFn(configPath);
  } catch {
    content = null;
  }

  const catalog = buildHermesCatalogFromContent(content, process.env);
  if (!io && mtimeMs !== null && catalog.defaultProviderReadable) {
    catalogCache = {
      hermesHome,
      mtimeMs,
      catalog,
    };
  }
  return catalog;
}

export async function loadHermesCatalog(
  config?: Record<string, unknown>,
  options?: { forceRefresh?: boolean },
): Promise<HermesCatalog> {
  const hermesHome = resolveHermesHome(config);
  const configPath = join(hermesHome, "config.yaml");

  if (options?.forceRefresh) {
    catalogCache = null;
  }

  let mtimeMs: number | null = null;
  try {
    const st = await fsPromises.stat(configPath);
    mtimeMs = typeof (st as any)?.mtimeMs === "number" ? (st as any).mtimeMs : null;
  } catch {
    mtimeMs = null;
  }

  if (
    !options?.forceRefresh &&
    mtimeMs !== null &&
    catalogCache &&
    catalogCache.hermesHome === hermesHome &&
    catalogCache.mtimeMs === mtimeMs
  ) {
    const cached = {
      ...catalogCache.catalog,
      configuredProviders: [...catalogCache.catalog.configuredProviders],
      modelsByProvider: { ...catalogCache.catalog.modelsByProvider },
      providers: catalogCache.catalog.providers.map((p) => ({
        ...p,
        models: [...p.models],
      })),
    };
    const policy = computePolicy(cached, process.env);
    cached.allowedProviders = Array.from(policy.allowedProviders);
    return cached;
  }

  let content: string | null = null;
  try {
    const raw = await fsPromises.readFile(configPath, "utf-8");
    content = typeof raw === "string" ? raw : null;
  } catch {
    content = null;
  }

  const catalog = buildHermesCatalogFromContent(content, process.env);
  if (mtimeMs !== null && catalog.defaultProviderReadable) {
    catalogCache = {
      hermesHome,
      mtimeMs,
      catalog,
    };
  }
  return catalog;
}

export function computePolicy(
  catalog: HermesCatalog,
  env: NodeJS.ProcessEnv = process.env,
): HermesProviderPolicy {
  const rawAllowEnv = env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
  if (typeof rawAllowEnv === "string" && rawAllowEnv.trim().length > 0) {
    const slugs = rawAllowEnv
      .split(",")
      .map((s) => normalizeSlug(s))
      .filter((s) => s.length > 0 && s !== "auto");
    return {
      mode: "restrictive",
      allowedProviders: new Set(slugs),
    };
  }

  if (catalog.hasNamedProviders || catalog.configuredProviders.length > 0) {
    const slugs = catalog.configuredProviders
      .map((s) => normalizeSlug(s))
      .filter((s) => s.length > 0 && s !== "auto");
    return {
      mode: "restrictive",
      allowedProviders: new Set(slugs),
    };
  }

  const legacySlugs = VALID_PROVIDERS.map((s) => normalizeSlug(s)).filter(
    (s) => s.length > 0 && s !== "auto",
  );
  return {
    mode: "legacy",
    allowedProviders: new Set(legacySlugs),
  };
}

export function projectCatalogToAdapterModels(
  catalog: HermesCatalog,
  policy: HermesProviderPolicy = computePolicy(catalog, process.env),
): AdapterModel[] {
  const entries: AdapterModel[] = [];
  const seenIds = new Set<string>();

  for (const provider of catalog.providers) {
    if (!policy.allowedProviders.has(provider.id)) continue;
    for (const rawModelId of provider.models) {
      const id = `${provider.id}/${rawModelId}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push({
        id,
        label: rawModelId,
        providerId: provider.id,
        providerLabel: provider.label,
        rawModelId,
        isUserDefined: provider.isUserDefined,
      } as AdapterModel);
    }
  }

  if (catalog.defaultProvider && catalog.defaultModel) {
    const defaultCompositeId = `${normalizeSlug(catalog.defaultProvider)}/${catalog.defaultModel}`;
    const idx = entries.findIndex((e) => e.id === defaultCompositeId);
    if (idx > 0) {
      const [promoted] = entries.splice(idx, 1);
      if (promoted) entries.unshift(promoted);
    }
  }

  return entries;
}

export async function listHermesModels(): Promise<AdapterModel[]> {
  try {
    const catalog = await loadHermesCatalog(undefined, { forceRefresh: false });
    const policy = computePolicy(catalog, process.env);
    return projectCatalogToAdapterModels(catalog, policy);
  } catch {
    return [];
  }
}

export async function refreshHermesModels(): Promise<AdapterModel[]> {
  try {
    const catalog = await loadHermesCatalog(undefined, { forceRefresh: true });
    const policy = computePolicy(catalog, process.env);
    return projectCatalogToAdapterModels(catalog, policy);
  } catch {
    return [];
  }
}

function builtinProviderLabel(provider: string): string {
  if (provider === "auto") return "Auto";
  if (provider === "openai-codex") return "OpenAI Codex";
  if (provider === "kimi-coding") return "Kimi Coding";
  if (provider === "minimax-cn") return "MiniMax China";
  return provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function getDynamicConfigSchema(): Promise<AdapterConfigSchema> {
  let providerOptions: Array<{ value: string; label: string }> = [
    { value: "auto", label: "Auto" },
  ];

  try {
    const catalog = await loadHermesCatalog(undefined, { forceRefresh: false });
    const policy = computePolicy(catalog, process.env);
    const providerMap = new Map(catalog.providers.map((p) => [p.id, p]));

    const allowedList = Array.from(policy.allowedProviders);
    if (allowedList.length > 0) {
      providerOptions = [
        { value: "auto", label: "Auto" },
        ...allowedList.map((slug) => {
          const entry = providerMap.get(slug);
          const label = entry
            ? entry.label && entry.label !== slug
              ? `${entry.label} (${slug})`
              : slug
            : builtinProviderLabel(slug);
          return { value: slug, label };
        }),
      ];
    } else {
      providerOptions = VALID_PROVIDERS.map((p) => ({
        value: p,
        label: builtinProviderLabel(p),
      }));
    }
  } catch {
    providerOptions = VALID_PROVIDERS.map((p) => ({
      value: p,
      label: builtinProviderLabel(p),
    }));
  }

  return {
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "auto",
        options: providerOptions,
        hint: "Usually auto. Set this only when Hermes cannot infer the provider from the model or ~/.hermes/config.yaml.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before killing the Hermes process.",
      },
      {
        key: "maxTurnsPerRun",
        label: "Max turns per run",
        type: "number",
        hint: "Optional Hermes --max-turns limit for tool-calling iterations.",
      },
      {
        key: "toolsets",
        label: "Toolsets",
        type: "text",
        hint: "Optional comma-separated Hermes toolsets, such as terminal,file,web.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Resume Hermes sessions across Paperclip heartbeats.",
      },
      {
        key: "worktreeMode",
        label: "Hermes worktree mode",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --worktree.",
      },
      {
        key: "checkpoints",
        label: "Checkpoints",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --checkpoints.",
      },
      {
        key: "quiet",
        label: "Quiet output",
        type: "toggle",
        default: true,
        hint: "Pass Hermes --quiet for cleaner Paperclip run transcripts.",
      },
      {
        key: "verbose",
        label: "Verbose output",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --verbose.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional API base override. Defaults to PAPERCLIP_API_URL.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional custom prompt template with {{variable}} placeholders.",
      },
    ],
  };
}
