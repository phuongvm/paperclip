/**
 * Build adapter configuration from UI form values.
 *
 * Translates Paperclip's CreateConfigValues into the adapterConfig
 * object stored in the agent record.
 *
 * NOTE: Provider resolution happens at runtime in execute.ts, not here.
 * The UI may or may not pass a provider field. If it does, we persist it
 * as the user's explicit override. If not, execute.ts will detect it from
 * ~/.hermes/config.yaml at runtime.
 */

import type { AdapterModel, CreateConfigValues } from "@paperclipai/adapter-utils";

import {
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";

function normalizeHermesSlug(slug: string): string {
  return String(slug ?? "").trim().toLowerCase();
}

function decodeSelectedOption(option: AdapterModel): { provider: string; model: string } {
  const provider = option.providerId ? normalizeHermesSlug(option.providerId) : "auto";
  const model =
    typeof option.rawModelId === "string" && option.rawModelId.length > 0
      ? option.rawModelId
      : option.label || option.id;
  return { provider, model };
}

/**
 * Build a Hermes Agent adapter config from the Paperclip UI form values.
 */
export function buildHermesConfig(
  v: CreateConfigValues & {
    selectedAdapterModel?: AdapterModel | null;
    adapterModels?: AdapterModel[];
  },
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.adapterSchemaValues && typeof v.adapterSchemaValues === "object") {
    Object.assign(ac, v.adapterSchemaValues);
  }

  const matchedOption =
    v.selectedAdapterModel ??
    (Array.isArray(v.adapterModels) && typeof v.model === "string"
      ? v.adapterModels.find((m) => m.id === v.model) ?? null
      : null);

  if (matchedOption) {
    const decoded = decodeSelectedOption(matchedOption);
    if (decoded.model && decoded.model.toLowerCase() !== "auto") {
      ac.model = decoded.model;
    }
    const existingProvider =
      typeof ac.provider === "string" ? normalizeHermesSlug(ac.provider) : "";
    if (!existingProvider || existingProvider === "auto") {
      ac.provider = decoded.provider;
    } else {
      ac.provider = existingProvider;
    }
  } else {
    // Model (never persist literal "auto")
    const rawModel = typeof v.model === "string" ? v.model.trim() : "";
    if (rawModel && rawModel.toLowerCase() !== "auto") {
      ac.model = rawModel;
    } else if ("model" in ac && String(ac.model ?? "").trim().toLowerCase() === "auto") {
      delete ac.model;
    }
    if (typeof ac.provider === "string" && ac.provider.trim().length > 0) {
      ac.provider = normalizeHermesSlug(ac.provider);
    }
  }

  // NOTE: Provider is NOT set here because the Paperclip UI form
  // (CreateConfigValues) does not expose a provider field.
  // Instead, provider is resolved at runtime in execute.ts using
  // a priority chain:
  //   1. adapterConfig.provider (if set via API directly)
  //   2. ~/.hermes/config.yaml detection
  //   3. Model-name prefix inference
  //   4. "auto" fallback
  // This ensures correct provider routing even for agents created
  // before provider tracking existed.

  // Execution limits — let the user configure these from the Paperclip UI.
  // timeoutSec: wall-clock kill timeout for the hermes child process.
  // maxTurnsPerRun: maps to Hermes's --max-turns (agent tool-calling iterations).
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (v.maxTurnsPerRun > 0) {
    ac.maxTurnsPerRun = v.maxTurnsPerRun;
    // Scale timeout to match: ~20s per tool turn is generous headroom.
    // Never go below the default (1800s / 30 min).
    ac.timeoutSec = Math.max(DEFAULT_TIMEOUT_SEC, v.maxTurnsPerRun * 20);
  }

  // Session persistence (default: on)
  ac.persistSession = true;

  // Working directory
  if (v.cwd) {
    ac.cwd = v.cwd;
  }

  // Custom hermes binary path
  if (v.command) {
    ac.hermesCommand = v.command;
  }

  // Extra CLI arguments
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);
  }

  // Thinking/reasoning effort
  if (v.thinkingEffort) {
    const existing = (ac.extraArgs as string[]) || [];
    existing.push("--reasoning-effort", String(v.thinkingEffort));
    ac.extraArgs = existing;
  }

  // Prompt template
  if (v.promptTemplate) {
    ac.promptTemplate = v.promptTemplate;
  }

  // Heartbeat config is handled by Paperclip itself

  return ac;
}
