import { createHash } from "node:crypto";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { AdapterCatalogContext } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import {
  assertCompanyAccess as defaultAssertCompanyAccess,
  buildActorSecretContext,
} from "../routes/authz.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { findActiveServerAdapter } from "./registry.js";

const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);
const PROFILE_GRAMMAR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function computeCatalogCacheKey(input: {
  adapterType: string;
  normalizedRoot: string;
  profile?: string;
  secretId?: string;
  secretVersion?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.adapterType,
        input.normalizedRoot,
        input.profile ?? "",
        input.secretId ?? "",
        input.secretVersion ?? "",
      ]),
    )
    .digest("hex");
}

function normalizeGatewayTargetRootAndProfile(config: Record<string, unknown>): {
  apiBaseUrl: string;
  normalizedRoot: string;
  profile?: string;
} | null {
  const rawUrl =
    typeof config.apiBaseUrl === "string"
      ? config.apiBaseUrl.trim()
      : typeof config.url === "string"
        ? config.url.trim()
        : "";
  if (!rawUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  let path =
    parsed.port === DEFAULT_HERMES_DASHBOARD_PORT &&
    HERMES_DASHBOARD_API_PATHS.has(trimmedPath)
      ? "/api"
      : parsed.pathname.replace(/\/+$/, "");

  let profile: string | undefined;
  if (typeof config.profile === "string" && config.profile.trim().length > 0) {
    const candidate = config.profile.trim();
    if (PROFILE_GRAMMAR.test(candidate)) {
      profile = candidate;
    }
  }

  const pIdx = path.indexOf("/p/");
  if (pIdx >= 0) {
    const urlProf = path.slice(pIdx + 3);
    path = path.slice(0, pIdx);
    if (!profile && PROFILE_GRAMMAR.test(urlProf)) {
      profile = urlProf;
    }
  }

  return {
    apiBaseUrl: rawUrl,
    normalizedRoot: `${parsed.origin}${path}`,
    ...(profile ? { profile } : {}),
  };
}

function extractSecretIdentity(rawApiKey: unknown): {
  secretId: string;
  secretVersion: string;
} {
  if (
    typeof rawApiKey === "object" &&
    rawApiKey !== null &&
    !Array.isArray(rawApiKey) &&
    (rawApiKey as { type?: unknown }).type === "secret_ref" &&
    typeof (rawApiKey as { secretId?: unknown }).secretId === "string"
  ) {
    const ref = rawApiKey as { secretId: string; version?: number | string };
    return {
      secretId: ref.secretId,
      secretVersion: String(ref.version ?? "latest"),
    };
  }
  if (typeof rawApiKey === "string" && rawApiKey.trim().length > 0) {
    return {
      secretId: "inline",
      secretVersion: createHash("sha256")
        .update(rawApiKey.trim())
        .digest("hex")
        .slice(0, 16),
    };
  }
  return { secretId: "", secretVersion: "" };
}

export interface BuildAdapterCatalogContextDeps {
  assertCompanyAccess?: (req: Request, companyId: string) => void;
  assertCanReadAgentConfig?: (
    req: Request,
    agent: { id: string; companyId: string; adapterType: string },
  ) => Promise<void> | void;
  getAgentById?: (id: string) => Promise<{
    id: string;
    companyId: string;
    adapterType: string;
    adapterConfig?: unknown;
  } | null>;
  resolveAdapterConfigForRuntime?: (
    companyId: string,
    config: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export async function buildAdapterCatalogContext(
  input: {
    db?: Db;
    req: Request;
    companyId: string;
    adapterType: string;
    agentId: string;
  },
  deps?: BuildAdapterCatalogContextDeps,
): Promise<AdapterCatalogContext | null> {
  const assertAccess = deps?.assertCompanyAccess ?? defaultAssertCompanyAccess;
  assertAccess(input.req, input.companyId);

  const getAgent =
    deps?.getAgentById ??
    (input.db
      ? (id: string) => agentService(input.db!).getById(id)
      : async () => null);
  const agent = await getAgent(input.agentId);
  if (!agent || agent.companyId !== input.companyId) {
    throw notFound("Agent not found");
  }

  if (agent.adapterType !== input.adapterType) {
    throw unprocessable(
      `Agent adapter type "${agent.adapterType}" does not match requested adapter "${input.adapterType}".`,
    );
  }

  if (deps?.assertCanReadAgentConfig) {
    await deps.assertCanReadAgentConfig(input.req, agent);
  }

  const adapter = findActiveServerAdapter(input.adapterType);
  if (!adapter?.supportsAgentScopedCatalog) {
    return null;
  }

  const rawConfig = parseObject(agent.adapterConfig);
  const targetInfo = normalizeGatewayTargetRootAndProfile(rawConfig);
  if (!targetInfo) {
    return null;
  }

  const { secretId, secretVersion } = extractSecretIdentity(
    rawConfig.apiKey ?? rawConfig.token,
  );

  const resolvedConfig = deps?.resolveAdapterConfigForRuntime
    ? await deps.resolveAdapterConfigForRuntime(input.companyId, rawConfig)
    : input.db
      ? (
          await secretService(input.db).resolveAdapterConfigForRuntime(
            input.companyId,
            rawConfig,
            buildActorSecretContext(input.req, {
              consumerType: "agent",
              consumerId: agent.id,
            }),
            { adapterType: input.adapterType },
          )
        ).config
      : rawConfig;

  const resolvedKey =
    typeof resolvedConfig.apiKey === "string" &&
    resolvedConfig.apiKey.trim().length > 0
      ? resolvedConfig.apiKey.trim()
      : typeof resolvedConfig.token === "string" &&
          resolvedConfig.token.trim().length > 0
        ? resolvedConfig.token.trim()
        : "";

  const cacheKey = computeCatalogCacheKey({
    adapterType: input.adapterType,
    normalizedRoot: targetInfo.normalizedRoot,
    profile: targetInfo.profile,
    secretId,
    secretVersion,
  });

  return {
    apiBaseUrl: targetInfo.apiBaseUrl,
    ...(targetInfo.profile ? { profile: targetInfo.profile } : {}),
    ...(resolvedKey ? { authHeader: `Bearer ${resolvedKey}` } : {}),
    cacheKey,
  };
}
