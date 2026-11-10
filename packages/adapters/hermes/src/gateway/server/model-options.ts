import type {
  AdapterConfigSchema,
  AdapterModel,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";
import { VALID_PROVIDERS } from "../../shared/constants.js";
import { INSECURE_REMOTE_HTTP_ESCAPE_HATCH } from "./transport-security.js";
import {
  computePolicy,
  loadHermesCatalog,
  normalizeSlug,
  projectCatalogToAdapterModels,
  type HermesCatalog,
  type HermesProviderEntry,
  type HermesProviderPolicy,
} from "../../server/catalog.js";

export interface AdapterCatalogContext {
  apiBaseUrl: string;
  profile?: string;
  authHeader?: string;
  cacheKey: string;
}
import {
  resolveHermesInvocation,
  type HermesResolverErrorCode,
  type HermesResolverWarningCode,
} from "../../server/resolver.js";
import { resolveGatewayTarget } from "./target.js";

export const GATEWAY_CATALOG_TIMEOUT_MS = 3_000;
export const GATEWAY_CATALOG_TTL_MS = 60_000;

export type ParsedGatewayCatalog = {
  ok: true;
  catalog: HermesCatalog;
  providerLabels: Record<string, string>;
};

export type GatewayCatalogFailure = {
  ok: false;
  reason:
    | "invalid_payload"
    | "duplicate_slug"
    | "unauthorized"
    | "http_error"
    | "network_error"
    | "invalid_target";
  status?: number;
};

type CachedGatewayCatalogEntry = {
  fetchedAt: number;
  parsed: ParsedGatewayCatalog;
};

const activeCatalogCache = new Map<string, CachedGatewayCatalogEntry>();
const lastKnownGoodCatalogCache = new Map<string, ParsedGatewayCatalog>();

export function resetGatewayCatalogCacheForTests(): void {
  activeCatalogCache.clear();
  lastKnownGoodCatalogCache.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseModelOptionsPayload(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ParsedGatewayCatalog | GatewayCatalogFailure {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.providers)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const seenSlugs = new Set<string>();
  const providers: HermesProviderEntry[] = [];
  const configuredProviders: string[] = [];
  const modelsByProvider: Record<string, string[]> = {};
  const providerLabels: Record<string, string> = {};
  let hasNamedProviders = false;

  for (const rawRow of root.providers) {
    const row = asRecord(rawRow);
    if (!row) continue;
    if (typeof row.slug !== "string" || row.slug.trim().length === 0) {
      continue;
    }
    const slug = normalizeSlug(row.slug);
    if (!slug || slug === "auto") continue;
    if (seenSlugs.has(slug)) {
      return { ok: false, reason: "duplicate_slug" };
    }
    seenSlugs.add(slug);

    const name =
      typeof row.name === "string" && row.name.trim().length > 0
        ? row.name.trim()
        : slug;
    const isUserDefined = Boolean(row.is_user_defined);
    const rawModels = Array.isArray(row.models) ? row.models : [];
    const models: string[] = [];
    const seenModelIds = new Set<string>();
    for (const m of rawModels) {
      if (typeof m === "string" && m.trim().length > 0) {
        const trimmed = m.trim();
        if (!seenModelIds.has(trimmed)) {
          seenModelIds.add(trimmed);
          models.push(trimmed);
        }
      }
    }

    if (isUserDefined) {
      hasNamedProviders = true;
      configuredProviders.push(slug);
    }
    modelsByProvider[slug] = models;
    providerLabels[slug] = name;
    providers.push({
      id: slug,
      label: name,
      baseUrlHost: "",
      isUserDefined,
      models,
    });
  }

  const defaultProvider =
    typeof root.provider === "string" && root.provider.trim().length > 0
      ? normalizeSlug(root.provider)
      : "";
  const defaultModel =
    typeof root.model === "string" && root.model.trim().length > 0
      ? root.model.trim()
      : "";

  const catalog: HermesCatalog = {
    defaultProvider,
    defaultModel,
    defaultProviderReadable: Boolean(defaultProvider && defaultProvider !== "auto"),
    hasNamedProviders,
    configuredProviders,
    allowedProviders: [],
    modelsByProvider,
    providers,
  };

  const policy = computePolicy(catalog, env);
  catalog.allowedProviders = Array.from(policy.allowedProviders);

  return {
    ok: true,
    catalog,
    providerLabels,
  };
}

function logCatalogFailure(code: string, host: string): void {
  console.warn(`[hermes-gateway] catalog fetch outcome=${code} host=${host}`);
}

export async function fetchGatewayModelOptionsCatalog(input: {
  apiBaseUrl: string;
  profile?: string;
  authHeader?: string;
  cacheKey?: string;
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  parsed: ParsedGatewayCatalog | null;
  failure: GatewayCatalogFailure | null;
  fromLastKnownGood: boolean;
}> {
  const target = resolveGatewayTarget({
    apiBaseUrl: input.apiBaseUrl,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
  });
  if (!target.ok) {
    return {
      parsed: null,
      failure: { ok: false, reason: "invalid_target" },
      fromLastKnownGood: false,
    };
  }

  const cacheKey =
    input.cacheKey ?? `${target.normalizedRoot}|${target.profile ?? ""}`;
  const now = Date.now();

  if (!input.refresh) {
    const cached = activeCatalogCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < GATEWAY_CATALOG_TTL_MS) {
      return {
        parsed: cached.parsed,
        failure: null,
        fromLastKnownGood: false,
      };
    }
  }

  const query = input.refresh
    ? "/api/model/options?include_unconfigured=false&refresh=1"
    : "/api/model/options?include_unconfigured=false";
  const requestUrl = target.url(query);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(input.authHeader ? { Authorization: input.authHeader } : {}),
  };

  try {
    const response = await fetch(requestUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(GATEWAY_CATALOG_TIMEOUT_MS),
    });

    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "http_error";
      logCatalogFailure(
        reason === "unauthorized"
          ? "hermes_gateway_catalog_unauthorized"
          : `http_${response.status}`,
        target.root.host,
      );
      const lkg = lastKnownGoodCatalogCache.get(cacheKey) ?? null;
      return {
        parsed: lkg,
        failure: { ok: false, reason, status: response.status },
        fromLastKnownGood: Boolean(lkg),
      };
    }

    const json = await response.json();
    const parsed = parseModelOptionsPayload(json, input.env ?? process.env);
    if (!parsed.ok) {
      logCatalogFailure(parsed.reason, target.root.host);
      const lkg = lastKnownGoodCatalogCache.get(cacheKey) ?? null;
      return {
        parsed: lkg,
        failure: parsed,
        fromLastKnownGood: Boolean(lkg),
      };
    }

    activeCatalogCache.set(cacheKey, {
      fetchedAt: Date.now(),
      parsed,
    });
    lastKnownGoodCatalogCache.set(cacheKey, parsed);

    return {
      parsed,
      failure: null,
      fromLastKnownGood: false,
    };
  } catch {
    logCatalogFailure("network_or_timeout", target.root.host);
    const lkg = lastKnownGoodCatalogCache.get(cacheKey) ?? null;
    return {
      parsed: lkg,
      failure: { ok: false, reason: "network_error" },
      fromLastKnownGood: Boolean(lkg),
    };
  }
}

function resolveTier1EnvConfig(env: NodeJS.ProcessEnv = process.env): {
  apiBaseUrl: string;
  authHeader?: string;
  profile?: string;
} | null {
  const apiBaseUrl = (env.PAPERCLIP_HERMES_GATEWAY_URL ?? "").trim();
  if (!apiBaseUrl) return null;
  const apiKey = (env.PAPERCLIP_HERMES_GATEWAY_API_KEY ?? "").trim();
  const profile = (env.PAPERCLIP_HERMES_GATEWAY_PROFILE ?? "").trim();
  return {
    apiBaseUrl,
    ...(apiKey ? { authHeader: `Bearer ${apiKey}` } : {}),
    ...(profile ? { profile } : {}),
  };
}

async function resolveGatewayCatalogSource(
  ctx?: AdapterCatalogContext,
  options?: { refresh?: boolean },
): Promise<{
  catalog: HermesCatalog | null;
  providerLabels: Record<string, string>;
  source: "tier2" | "tier1_env" | "tier1_host";
}> {
  if (ctx && ctx.apiBaseUrl) {
    const res = await fetchGatewayModelOptionsCatalog({
      apiBaseUrl: ctx.apiBaseUrl,
      profile: ctx.profile,
      authHeader: ctx.authHeader,
      cacheKey: ctx.cacheKey,
      refresh: options?.refresh,
    });
    if (res.parsed) {
      return {
        catalog: res.parsed.catalog,
        providerLabels: res.parsed.providerLabels,
        source: "tier2",
      };
    }
    return {
      catalog: null,
      providerLabels: {},
      source: "tier2",
    };
  }

  const tier1Env = resolveTier1EnvConfig(process.env);
  if (tier1Env) {
    const res = await fetchGatewayModelOptionsCatalog({
      apiBaseUrl: tier1Env.apiBaseUrl,
      profile: tier1Env.profile,
      authHeader: tier1Env.authHeader,
      refresh: options?.refresh,
    });
    if (res.parsed) {
      return {
        catalog: res.parsed.catalog,
        providerLabels: res.parsed.providerLabels,
        source: "tier1_env",
      };
    }
    return {
      catalog: null,
      providerLabels: {},
      source: "tier1_env",
    };
  }

  const hostCatalog = await loadHermesCatalog(undefined, {
    forceRefresh: Boolean(options?.refresh),
  });
  const providerLabels: Record<string, string> = {};
  for (const p of hostCatalog.providers) {
    providerLabels[p.id] = p.label;
  }
  return {
    catalog: hostCatalog,
    providerLabels,
    source: "tier1_host",
  };
}

export async function listHermesGatewayModels(
  ctx?: AdapterCatalogContext,
): Promise<AdapterModel[]> {
  const resolved = await resolveGatewayCatalogSource(ctx, { refresh: false });
  if (!resolved.catalog) return [];
  const policy = computePolicy(resolved.catalog, process.env);
  return projectCatalogToAdapterModels(resolved.catalog, policy);
}

export async function refreshHermesGatewayModels(
  ctx?: AdapterCatalogContext,
): Promise<AdapterModel[]> {
  const resolved = await resolveGatewayCatalogSource(ctx, { refresh: true });
  if (!resolved.catalog) return [];
  const policy = computePolicy(resolved.catalog, process.env);
  return projectCatalogToAdapterModels(resolved.catalog, policy);
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

export async function getHermesGatewayConfigSchema(
  ctx?: AdapterCatalogContext,
): Promise<AdapterConfigSchema> {
  const resolved = await resolveGatewayCatalogSource(ctx, { refresh: false });
  const catalog = resolved.catalog;

  let providerOptions: Array<{ value: string; label: string }> = [
    { value: "auto", label: "Auto" },
  ];
  const providerModels: Record<string, string[]> = {};
  const providerLabels: Record<string, string> = {};
  let allowedProviders: string[] = [];
  let defaultProvider = "";
  let defaultModel = "";

  if (catalog) {
    const policy = computePolicy(catalog, process.env);
    allowedProviders = Array.from(policy.allowedProviders).filter(
      (slug) => slug !== "auto",
    );
    defaultProvider = catalog.defaultProvider || "";
    defaultModel = catalog.defaultModel || "";

    for (const slug of allowedProviders) {
      const models = catalog.modelsByProvider[slug];
      if (models) {
        providerModels[slug] = [...models];
      }
      const label =
        resolved.providerLabels[slug] ?? builtinProviderLabel(slug);
      providerLabels[slug] = label;
    }

    providerOptions = [
      { value: "auto", label: "Auto" },
      ...allowedProviders.map((slug) => {
        const displayName = providerLabels[slug] ?? builtinProviderLabel(slug);
        return {
          value: slug,
          label: `${displayName} (${slug})`,
        };
      }),
    ];
  } else {
    const fallbackAllowed = VALID_PROVIDERS.map((p) => normalizeSlug(p)).filter(
      (p) => p && p !== "auto",
    );
    allowedProviders = fallbackAllowed;
    providerOptions = [
      { value: "auto", label: "Auto" },
      ...fallbackAllowed.map((slug) => {
        const displayName = builtinProviderLabel(slug);
        providerLabels[slug] = displayName;
        return {
          value: slug,
          label: `${displayName} (${slug})`,
        };
      }),
    ];
  }

  const providerHint =
    resolved.source === "tier2"
      ? "Select 'Auto' to use the gateway's default provider, or pin an allowed provider slug."
      : "Single-gateway-per-process Tier 1 catalog (host or PAPERCLIP_HERMES_GATEWAY_URL). Select 'Auto' or pin an allowed provider slug.";

  return {
    fields: [
      {
        key: "apiBaseUrl",
        label: "API base URL",
        type: "text",
        required: true,
        hint: "Hermes API server base URL, such as http://127.0.0.1:8642 or a private HTTPS URL. The default dashboard root or chat URL, such as http://127.0.0.1:9119/chat, is accepted and maps to /api.",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "text",
        required: true,
        hint: "Hermes API_SERVER_KEY, not PAPERCLIP_API_KEY. Stored as a Paperclip secret reference.",
        meta: { secret: true },
      },
      {
        key: "profile",
        label: "Profile",
        type: "text",
        hint: "Optional Hermes profile slug (^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$). Routes requests through :8642/p/{profile} or :9119/api/p/{profile}.",
      },
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "auto",
        options: providerOptions,
        hint: providerHint,
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        hint: "Raw model ID for the selected provider (or leave blank / auto for the gateway default).",
        meta: {
          providerModels,
          providerLabels,
          allowedProviders,
          defaultProvider,
          defaultModel,
        },
      },
      {
        key: INSECURE_REMOTE_HTTP_ESCAPE_HATCH,
        label: "Dangerously allow remote HTTP",
        type: "toggle",
        default: false,
        hint: "Unsafe dev-only escape hatch. Remote Hermes gateways should use HTTPS; loopback HTTP remains allowed.",
      },
      {
        key: "sessionKeyStrategy",
        label: "Session key strategy",
        type: "select",
        default: "issue",
        options: [
          { value: "issue", label: "Issue scoped" },
          { value: "agent", label: "Agent scoped" },
          { value: "run", label: "Run scoped" },
          { value: "none", label: "None" },
        ],
        hint: "Controls X-Hermes-Session-Key. Issue scoped prevents cross-task memory bleed by default.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "eventReconnectMs",
        label: "Event reconnect ms",
        type: "number",
        default: DEFAULT_EVENT_RECONNECT_MS,
        hint: "Delay before reconnecting the Hermes SSE events stream after a nonterminal disconnect.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional Paperclip API URL reachable by the remote Hermes host. This is not a credential.",
      },
      {
        key: "headers",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of extra nonsecret headers. Security-critical headers are generated by the adapter.",
      },
      {
        key: "instructions",
        label: "Instructions",
        type: "textarea",
        hint: "Optional stable Hermes instructions sent separately from the wake input.",
      },
    ],
  };
}

export type BuildRunSelectionResult =
  | {
      ok: true;
      selection: {
        provider?: string;
        model?: string;
        model_options?: Record<string, unknown>;
      };
      warnings: HermesResolverWarningCode[];
      resolvedFrom: string;
    }
  | {
      ok: false;
      errorCode: HermesResolverErrorCode;
      provider?: string;
      reason?: "default_unreadable" | "default_auto" | "catalog_unavailable";
      resolvedFrom?: string;
    };

export function buildRunSelection(
  config: Record<string, unknown>,
  catalog?: HermesCatalog | null,
  policy?: HermesProviderPolicy,
): BuildRunSelectionResult {
  const payloadTemplate = parseObject(config.payloadTemplate);
  const rawProvider =
    config.provider !== undefined && config.provider !== null
      ? asString(config.provider, "")
      : asString(payloadTemplate.provider, "");
  const rawModel =
    config.model !== undefined && config.model !== null
      ? asString(config.model, "")
      : asString(payloadTemplate.model, "");

  const effectiveCatalog: HermesCatalog = catalog ?? {
    defaultProvider: "",
    defaultModel: "",
    defaultProviderReadable: false,
    hasNamedProviders: false,
    configuredProviders: [],
    allowedProviders: [],
    modelsByProvider: {},
    providers: [],
  };

  const effectivePolicy =
    policy ?? computePolicy(effectiveCatalog, process.env);

  // Ensure explicit allowed providers in env are also treated as known providers
  // when the gateway catalog is temporarily unreachable.
  const catalogForResolver: HermesCatalog =
    !catalog && effectivePolicy.mode === "restrictive"
      ? {
          ...effectiveCatalog,
          hasNamedProviders: true,
          configuredProviders: Array.from(effectivePolicy.allowedProviders),
          allowedProviders: Array.from(effectivePolicy.allowedProviders),
        }
      : effectiveCatalog;

  const resolved = resolveHermesInvocation({
    configModel: rawModel,
    configProvider: rawProvider,
    catalog: catalogForResolver,
    policy: effectivePolicy,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      errorCode: resolved.errorCode,
      provider: resolved.provider,
      reason:
        !catalog && resolved.errorCode === "hermes_effective_provider_unverified"
          ? "catalog_unavailable"
          : resolved.reason,
      resolvedFrom: resolved.resolvedFrom,
    };
  }

  const modelOptions = parseObject(
    config.modelOptions ?? config.model_options ?? payloadTemplate.model_options,
  );

  return {
    ok: true,
    selection: {
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(Object.keys(modelOptions).length > 0
        ? { model_options: modelOptions }
        : {}),
    },
    warnings: resolved.warnings,
    resolvedFrom: resolved.resolvedFrom,
  };
}
