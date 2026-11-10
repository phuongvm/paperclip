import type { AdapterModel } from "@paperclipai/adapter-utils";
import { VALID_PROVIDERS } from "../shared/constants.js";
import {
  normalizeSlug,
  type HermesCatalog,
  type HermesProviderPolicy,
} from "./catalog.js";
import { inferProviderFromModel } from "./detect-model.js";

export type HermesResolverWarningCode =
  | "hermes_model_not_in_provider_catalog"
  | "hermes_model_ambiguous_legacy_composite";

export type HermesResolverErrorCode =
  | "hermes_provider_unknown"
  | "hermes_provider_disallowed_by_policy"
  | "hermes_effective_provider_unverified";

export type HermesInvocationResolution =
  | {
      ok: true;
      model?: string;
      provider?: string;
      pinned: boolean;
      resolvedFrom: string;
      warnings: HermesResolverWarningCode[];
    }
  | {
      ok: false;
      errorCode: HermesResolverErrorCode;
      provider?: string;
      reason?: "default_unreadable" | "default_auto" | "catalog_unavailable";
      resolvedFrom?: string;
    };

export function selectionFromOption(option: AdapterModel): {
  provider: string;
  model: string;
} {
  const anyOpt = option as AdapterModel & {
    providerId?: string;
    rawModelId?: string;
  };
  const provider = anyOpt.providerId ? normalizeSlug(anyOpt.providerId) : "auto";
  const model =
    typeof anyOpt.rawModelId === "string" && anyOpt.rawModelId.length > 0
      ? anyOpt.rawModelId
      : option.label || option.id;
  return { provider, model };
}

export function composeHermesOptionId(
  selection: { provider?: string | null; model?: string | null },
  catalog: HermesCatalog,
): string {
  const rawModel = typeof selection.model === "string" ? selection.model.trim() : "";
  if (!rawModel || rawModel.toLowerCase() === "auto") return "";

  const rawProvider =
    typeof selection.provider === "string" ? normalizeSlug(selection.provider) : "";
  if (rawProvider && rawProvider !== "auto") {
    const providerModels = catalog.modelsByProvider[rawProvider] ?? [];
    if (providerModels.includes(rawModel)) {
      return `${rawProvider}/${rawModel}`;
    }
    return rawModel;
  }

  const matchingProviders = catalog.configuredProviders.filter((p) =>
    (catalog.modelsByProvider[p] ?? []).includes(rawModel),
  );
  if (matchingProviders.length === 1) {
    return `${matchingProviders[0]}/${rawModel}`;
  }
  const defaultSlug = normalizeSlug(catalog.defaultProvider);
  if (defaultSlug && matchingProviders.includes(defaultSlug)) {
    return `${defaultSlug}/${rawModel}`;
  }
  return rawModel;
}

function buildKnownProviderSet(catalog: HermesCatalog): Set<string> {
  const known = new Set<string>();
  for (const p of VALID_PROVIDERS) {
    const norm = normalizeSlug(p);
    if (norm && norm !== "auto") known.add(norm);
  }
  for (const p of catalog.configuredProviders) {
    const norm = normalizeSlug(p);
    if (norm && norm !== "auto") known.add(norm);
  }
  return known;
}

function checkRuleBCandidate(
  model: string | undefined,
  catalog: HermesCatalog,
  policy: HermesProviderPolicy,
): { provider: string; model: string } | null {
  if (!model) return null;
  const slashIdx = model.indexOf("/");
  if (slashIdx <= 0) return null;
  const candidateProvider = normalizeSlug(model.slice(0, slashIdx));
  const candidateModel = model.slice(slashIdx + 1);
  if (!candidateProvider || !candidateModel) return null;
  if (!policy.allowedProviders.has(candidateProvider)) return null;
  const catalogModels = catalog.modelsByProvider[candidateProvider] ?? [];
  if (!catalogModels.includes(candidateModel)) return null;
  return { provider: candidateProvider, model: candidateModel };
}

export function resolveHermesInvocation(input: {
  configModel?: string | null;
  configProvider?: string | null;
  catalog: HermesCatalog;
  policy: HermesProviderPolicy;
}): HermesInvocationResolution {
  const { catalog, policy } = input;
  const warnings: HermesResolverWarningCode[] = [];
  const knownProviders = buildKnownProviderSet(catalog);

  const rawModel = typeof input.configModel === "string" ? input.configModel.trim() : "";
  const effectiveInputModel =
    !rawModel || rawModel.toLowerCase() === "auto" ? undefined : rawModel;

  const rawProvider =
    typeof input.configProvider === "string" ? normalizeSlug(input.configProvider) : "";
  const hasExplicitNonAutoProvider = Boolean(rawProvider && rawProvider !== "auto");

  if (hasExplicitNonAutoProvider) {
    if (!knownProviders.has(rawProvider)) {
      return {
        ok: false,
        errorCode: "hermes_provider_unknown",
        provider: rawProvider,
        resolvedFrom: "adapterConfig",
      };
    }
    if (!policy.allowedProviders.has(rawProvider)) {
      return {
        ok: false,
        errorCode: "hermes_provider_disallowed_by_policy",
        provider: rawProvider,
        resolvedFrom: "adapterConfig",
      };
    }
    const providerCatalog = catalog.modelsByProvider[rawProvider];
    if (
      effectiveInputModel &&
      Array.isArray(providerCatalog) &&
      providerCatalog.length > 0 &&
      !providerCatalog.includes(effectiveInputModel)
    ) {
      warnings.push("hermes_model_not_in_provider_catalog");
    }
    return {
      ok: true,
      model: effectiveInputModel,
      provider: rawProvider,
      pinned: true,
      resolvedFrom: "adapterConfig",
      warnings,
    };
  }

  if (policy.mode === "restrictive") {
    if (!catalog.defaultProviderReadable) {
      return {
        ok: false,
        errorCode: "hermes_effective_provider_unverified",
        reason: "default_unreadable",
        resolvedFrom: "hermesConfig",
      };
    }

    const hostDefault = normalizeSlug(catalog.defaultProvider || "");

    const directAllowedMembers = effectiveInputModel
      ? Array.from(policy.allowedProviders).filter((slug) =>
          (catalog.modelsByProvider[slug] ?? []).includes(effectiveInputModel),
        )
      : [];

    const ruleB = checkRuleBCandidate(effectiveInputModel, catalog, policy);

    if (directAllowedMembers.length > 0) {
      if (!hostDefault || hostDefault === "auto") {
        return {
          ok: false,
          errorCode: "hermes_effective_provider_unverified",
          reason: "default_auto",
          resolvedFrom: "hermesConfig",
        };
      }
      if (!knownProviders.has(hostDefault)) {
        return {
          ok: false,
          errorCode: "hermes_provider_unknown",
          provider: hostDefault,
          resolvedFrom: "hermesConfig",
        };
      }
      if (!policy.allowedProviders.has(hostDefault)) {
        return {
          ok: false,
          errorCode: "hermes_provider_disallowed_by_policy",
          provider: hostDefault,
          resolvedFrom: "hermesConfig",
        };
      }

      if (ruleB) {
        warnings.push("hermes_model_ambiguous_legacy_composite");
      }

      const chosenProvider = directAllowedMembers.includes(hostDefault)
        ? hostDefault
        : directAllowedMembers[0]!;
      const resolvedFrom =
        chosenProvider === hostDefault ? "hermesConfig" : "catalogMembership";

      return {
        ok: true,
        model: effectiveInputModel,
        provider: chosenProvider,
        pinned: true,
        resolvedFrom,
        warnings,
      };
    }

    if (!rawProvider && ruleB) {
      return {
        ok: true,
        model: ruleB.model,
        provider: ruleB.provider,
        pinned: true,
        resolvedFrom: "legacyComposite",
        warnings,
      };
    }

    if (!hostDefault || hostDefault === "auto") {
      return {
        ok: false,
        errorCode: "hermes_effective_provider_unverified",
        reason: "default_auto",
        resolvedFrom: "hermesConfig",
      };
    }
    if (!knownProviders.has(hostDefault)) {
      return {
        ok: false,
        errorCode: "hermes_provider_unknown",
        provider: hostDefault,
        resolvedFrom: "hermesConfig",
      };
    }
    if (!policy.allowedProviders.has(hostDefault)) {
      return {
        ok: false,
        errorCode: "hermes_provider_disallowed_by_policy",
        provider: hostDefault,
        resolvedFrom: "hermesConfig",
      };
    }

    return {
      ok: true,
      model: effectiveInputModel,
      provider: hostDefault,
      pinned: true,
      resolvedFrom: "hermesConfig",
      warnings,
    };
  }

  const hostDefault = normalizeSlug(catalog.defaultProvider || "");
  const configMatchesModel =
    !effectiveInputModel ||
    (Boolean(catalog.defaultModel) &&
      catalog.defaultModel.toLowerCase() === effectiveInputModel.toLowerCase());

  if (configMatchesModel && hostDefault && hostDefault !== "auto") {
    if (policy.allowedProviders.has(hostDefault)) {
      return {
        ok: true,
        model: effectiveInputModel,
        provider: hostDefault,
        pinned: true,
        resolvedFrom: "hermesConfig",
        warnings,
      };
    }
    return {
      ok: true,
      model: effectiveInputModel,
      provider: undefined,
      pinned: false,
      resolvedFrom: `hermesConfigUnsupported:${hostDefault}`,
      warnings,
    };
  }

  if (effectiveInputModel) {
    const inferred = inferProviderFromModel(effectiveInputModel);
    const normInferred = inferred ? normalizeSlug(inferred) : "";
    if (normInferred && normInferred !== "auto" && policy.allowedProviders.has(normInferred)) {
      return {
        ok: true,
        model: effectiveInputModel,
        provider: normInferred,
        pinned: false,
        resolvedFrom: "modelInference",
        warnings,
      };
    }
  }

  return {
    ok: true,
    model: effectiveInputModel,
    provider: undefined,
    pinned: false,
    resolvedFrom: "auto",
    warnings,
  };
}
