import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { VALID_PROVIDERS } from "../shared/constants.js";
import { computePolicy, normalizeSlug, parseHermesProvidersAndModels } from "./catalog.js";
import { parseModelFromConfig, resolveProvider } from "./detect-model.js";
import { resolveHermesInvocation } from "./resolver.js";
import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "PAPERCLIP_HERMES_ALLOWED_PROVIDERS",
  "PAPERCLIP_ADAPTER_MODELS",
];

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  HERMES_HOME: process.env.HERMES_HOME,
  ...Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])),
};

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("parseModelFromConfig tracks api_key presence without exposing the raw secret", () => {
  const parsed = parseModelFromConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: super-secret-value",
    "",
  ].join("\n"));

  expect(parsed).toBeTruthy();
  expect(parsed?.hasApiKey).toBe(true);
  expect(Object.hasOwn(parsed ?? {}, "apiKey")).toBe(false);
});

test("resolveProvider does not fall through to model inference when Hermes config provider is unsupported but matches the requested model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigUnsupported:custom",
  });
});

test("resolveProvider also defers to Hermes runtime when the matching config omits provider but includes runtime signals", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "oca/gpt-5.4",
  })).toEqual({
    provider: "auto",
    resolvedFrom: "hermesConfigRuntime",
  });
});

test("resolveProvider still infers from the requested model when Hermes config is for a different model", () => {
  expect(resolveProvider({
    explicitProvider: undefined,
    detectedProvider: "custom",
    detectedModel: "oca/gpt-5.4",
    detectedBaseUrl: "https://example.invalid/litellm",
    detectedHasApiKey: true,
    model: "claude-sonnet-4",
  })).toEqual({
    provider: "anthropic",
    resolvedFrom: "modelInference",
  });
});

async function withHermesHomeConfig(
  configLines: string[],
  fn: () => Promise<void>,
) {
  const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
  const hermesDir = join(tempHome, ".hermes");
  const configPath = join(hermesDir, "config.yaml");

  await mkdir(hermesDir, { recursive: true });
  await writeFile(configPath, `${configLines.join("\n")}\n`, "utf8");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  delete process.env.HERMES_HOME;
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }

  try {
    await fn();
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

test("testEnvironment does not warn about missing API keys when Hermes config provides a supported provider api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: openrouter/gpt-4.1-mini",
    "  provider: openrouter",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: process.execPath,
        model: "openrouter/gpt-4.1-mini",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("testEnvironment describes provider-omitted runtime config without inventing provider auto", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: process.execPath,
        model: "oca/gpt-5.4",
      },
    });

    const apiKeyCheck = result.checks.find((check) => check.code === "hermes_api_key_in_config");
    expect(apiKeyCheck).toBeTruthy();
    expect(apiKeyCheck?.message).toMatch(/without an explicit provider/i);
    expect(apiKeyCheck?.message).not.toMatch(/provider "auto"/i);
  });
});

test("testEnvironment does not warn about missing API keys when Hermes config provides a custom provider base_url and api_key", async () => {
  await withHermesHomeConfig([
    "model:",
    "  default: oca/gpt-5.4",
    "  provider: custom",
    "  base_url: https://example.invalid/litellm",
    "  api_key: test-secret",
  ], async () => {
    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: process.execPath,
        model: "oca/gpt-5.4",
      },
    });

    const codes = result.checks.map((check) => check.code);

    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(result.status).toBe("pass");
  });
});

test("testEnvironment resolves HERMES_HOME config.yaml key_env and .env without warning", async () => {
  const customHermesHome = await mkdtemp(join(tmpdir(), "hermes-custom-home-"));
  const emptyUserHome = await mkdtemp(join(tmpdir(), "hermes-empty-user-"));
  try {
    await writeFile(
      join(customHermesHome, "config.yaml"),
      [
        "model:",
        "  default: cb-gemini-argon",
        "  provider: ai-router",
        "  base_url: http://192.168.100.110:20128/v1",
        "  api_mode: chat_completions",
        "  key_env: HERMES_CUSTOM_AI_ROUTER_API_KEY",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(customHermesHome, ".env"),
      "HERMES_CUSTOM_AI_ROUTER_API_KEY=router-test-token\n",
      "utf8",
    );

    process.env.HOME = emptyUserHome;
    process.env.USERPROFILE = emptyUserHome;
    process.env.HERMES_HOME = customHermesHome;
    for (const key of providerEnvKeys) {
      delete process.env[key];
    }

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        hermesCommand: process.execPath,
      },
    });

    const codes = result.checks.map((check) => check.code);
    expect(codes.includes("hermes_no_api_keys")).toBe(false);
    expect(codes.includes("hermes_custom_provider_config")).toBe(true);
    expect(result.status).toBe("pass");
  } finally {
    await rm(customHermesHome, { recursive: true, force: true });
    await rm(emptyUserHome, { recursive: true, force: true });
  }
});

const ROUTER_CONFIG_YAML = [
  "model:",
  "  default: cb-gemini-flash-high",
  "  provider: ai-router",
  "  base_url: http://192.168.100.110:20128/v1",
  "  api_mode: chat_completions",
  "  key_env: HERMES_CUSTOM_AI_ROUTER_API_KEY",
  "providers:",
  "  ai-router:",
  "    name: 9Router Proxy",
  "    enabled: true",
  "    base_url: http://192.168.100.110:20128/v1",
  "    key_env: HERMES_CUSTOM_AI_ROUTER_API_KEY",
  "    models:",
  "      cb-gemini-flash-high:",
  "        name: Gemini Flash High",
  "      cc/claude-sonnet-5:",
  "        name: Claude Sonnet 5",
  "      ai-router/native:",
  "        name: Native Router Model",
  "  headroom-proxy:",
  "    name: Headroom Proxy",
  "    enabled: true",
  "    base_url: http://192.168.100.110:8203/v1",
  "    key_env: HERMES_CUSTOM_HEADROOM_PROXY_API_KEY",
  "    models:",
  "      - cb-gemini-flash-high",
  "      - cc/claude-sonnet-5",
  "      - cb-opus-4.6-thinking",
  "  legacy-router:",
  "    name: Disabled Legacy Router",
  "    enabled: false",
  "    models:",
  "      - legacy-model-1",
  "",
].join("\n");

async function withCustomHermesHome(
  yamlContent: string | null,
  fn: (hermesHome: string) => Promise<void>,
) {
  const customHermesHome = await mkdtemp(join(tmpdir(), "hermes-policy-home-"));
  const emptyUserHome = await mkdtemp(join(tmpdir(), "hermes-empty-user-"));
  try {
    if (yamlContent !== null) {
      await writeFile(join(customHermesHome, "config.yaml"), yamlContent, "utf8");
    }
    await writeFile(
      join(customHermesHome, ".env"),
      [
        "HERMES_CUSTOM_AI_ROUTER_API_KEY=redacted-test-router-token",
        "HERMES_CUSTOM_HEADROOM_PROXY_API_KEY=redacted-test-headroom-token",
      ].join("\n") + "\n",
      "utf8",
    );
    process.env.HOME = emptyUserHome;
    process.env.USERPROFILE = emptyUserHome;
    process.env.HERMES_HOME = customHermesHome;
    for (const key of providerEnvKeys) {
      if (key !== "HERMES_HOME") delete process.env[key];
    }
    await fn(customHermesHome);
  } finally {
    await rm(customHermesHome, { recursive: true, force: true });
    await rm(emptyUserHome, { recursive: true, force: true });
  }
}

describe("policy", () => {
  test("derives restrictive configured set {ai-router, headroom-proxy} with no auto and excludes disabled legacy-router", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      expect(catalog.configuredProviders).toEqual(["ai-router", "headroom-proxy"]);
      expect(catalog.configuredProviders).not.toContain("legacy-router");
      expect(catalog.configuredProviders).not.toContain("auto");
      expect(policy.mode).toBe("restrictive");
      expect(Array.from(policy.allowedProviders)).toEqual(["ai-router", "headroom-proxy"]);
      expect(policy.allowedProviders.has("auto")).toBe(false);
      expect(policy.allowedProviders.has("legacy-router")).toBe(false);
    });
  });

  test("PAPERCLIP_HERMES_ALLOWED_PROVIDERS normalizes slugs, strips auto, and enforces restrictive mode", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, {
        ...process.env,
        PAPERCLIP_HERMES_ALLOWED_PROVIDERS: " AI-Router , auto ,headroom-proxy",
      });

      expect(normalizeSlug(" AI-Router ")).toBe("ai-router");
      expect(policy.mode).toBe("restrictive");
      expect(Array.from(policy.allowedProviders)).toEqual(["ai-router", "headroom-proxy"]);
      expect(policy.allowedProviders.has("auto")).toBe(false);
    });
  });

  test("vanilla host without named providers or env allow-list falls back to VALID_PROVIDERS minus auto in legacy mode", async () => {
    const vanillaYaml = [
      "model:",
      "  default: openrouter/gpt-4.1-mini",
      "  provider: openrouter",
      "",
    ].join("\n");
    await withCustomHermesHome(vanillaYaml, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      expect(catalog.hasNamedProviders).toBe(false);
      expect(policy.mode).toBe("legacy");
      const expected = VALID_PROVIDERS.filter((p) => p !== "auto");
      expect(Array.from(policy.allowedProviders)).toEqual(expected);
      expect(policy.allowedProviders.has("auto")).toBe(false);
    });
  });

  test("rejects explicit anthropic with hermes_provider_disallowed_by_policy and bogus/legacy-router with hermes_provider_unknown", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const anthropicRes = resolveHermesInvocation({
        configProvider: "anthropic",
        configModel: "cb-gemini-flash-high",
        catalog,
        policy,
      });
      expect(anthropicRes).toMatchObject({
        ok: false,
        errorCode: "hermes_provider_disallowed_by_policy",
        provider: "anthropic",
      });

      const bogusRes = resolveHermesInvocation({
        configProvider: "bogus",
        configModel: "cb-gemini-flash-high",
        catalog,
        policy,
      });
      expect(bogusRes).toMatchObject({
        ok: false,
        errorCode: "hermes_provider_unknown",
        provider: "bogus",
      });

      const disabledRes = resolveHermesInvocation({
        configProvider: "legacy-router",
        configModel: "legacy-model-1",
        catalog,
        policy,
      });
      expect(disabledRes).toMatchObject({
        ok: false,
        errorCode: "hermes_provider_unknown",
        provider: "legacy-router",
      });

      const envTestDisallowed = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: process.execPath,
          provider: "anthropic",
          model: "cb-gemini-flash-high",
        },
      });
      expect(envTestDisallowed.status).toBe("fail");
      expect(envTestDisallowed.checks.map((c) => c.code)).toContain(
        "hermes_provider_disallowed_by_policy",
      );

      const envTestUnknown = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: process.execPath,
          provider: "bogus",
          model: "cb-gemini-flash-high",
        },
      });
      expect(envTestUnknown.status).toBe("fail");
      expect(envTestUnknown.checks.map((c) => c.code)).toContain("hermes_provider_unknown");
    });
  });

  test("normalizes persisted AI-Router slug to ai-router at policy boundary (R3-I02)", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const res = resolveHermesInvocation({
        configProvider: "  AI-Router ",
        configModel: "cb-gemini-flash-high",
        catalog,
        policy,
      });
      expect(res).toEqual({
        ok: true,
        provider: "ai-router",
        model: "cb-gemini-flash-high",
        pinned: true,
        resolvedFrom: "adapterConfig",
        warnings: [],
      });
    });
  });

  test("preserves PAPERCLIP_ADAPTER_MODELS stop-gap env without interfering with provider policy derivation", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
        hermes_local: [{ id: "ai-router/declared-stopgap", label: "declared-stopgap" }],
      });
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      expect(policy.mode).toBe("restrictive");
      expect(Array.from(policy.allowedProviders)).toEqual(["ai-router", "headroom-proxy"]);
      expect(JSON.parse(process.env.PAPERCLIP_ADAPTER_MODELS).hermes_local).toEqual([
        { id: "ai-router/declared-stopgap", label: "declared-stopgap" },
      ]);
    });
  });
});

describe("effective provider", () => {
  test("auto + model.provider=ai-router resolves and pins --provider ai-router (R2-P05)", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const res = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "",
        catalog,
        policy,
      });
      expect(res).toEqual({
        ok: true,
        provider: "ai-router",
        model: undefined,
        pinned: true,
        resolvedFrom: "hermesConfig",
        warnings: [],
      });
    });
  });

  test("auto + host default anthropic fails closed with hermes_provider_disallowed_by_policy", async () => {
    const disallowedHostYaml = ROUTER_CONFIG_YAML.replace(
      "  provider: ai-router",
      "  provider: anthropic",
    );
    await withCustomHermesHome(disallowedHostYaml, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const res = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "",
        catalog,
        policy,
      });
      expect(res).toMatchObject({
        ok: false,
        errorCode: "hermes_provider_disallowed_by_policy",
        provider: "anthropic",
      });

      const envResult = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: process.execPath,
          provider: "auto",
        },
      });
      expect(envResult.status).toBe("fail");
      expect(envResult.checks.map((c) => c.code)).toContain(
        "hermes_provider_disallowed_by_policy",
      );
    });
  });

  test("auto + missing config.yaml in restrictive mode fails closed with hermes_effective_provider_unverified (default_unreadable)", async () => {
    await withCustomHermesHome(null, async (hermesHome) => {
      process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS = "ai-router,headroom-proxy";
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const res = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "",
        catalog,
        policy,
      });
      expect(res).toMatchObject({
        ok: false,
        errorCode: "hermes_effective_provider_unverified",
        reason: "default_unreadable",
      });

      const envResult = await testEnvironment({
        companyId: "company-test",
        adapterType: "hermes_local",
        config: {
          hermesCommand: process.execPath,
          provider: "auto",
        },
      });
      expect(envResult.status).toBe("fail");
      expect(envResult.checks.map((c) => c.code)).toContain(
        "hermes_effective_provider_unverified",
      );
    });
  });

  test("auto + model.provider empty or auto in restrictive mode fails closed with hermes_effective_provider_unverified (default_auto)", async () => {
    for (const badDefault of ["", "auto"]) {
      const yaml = ROUTER_CONFIG_YAML.replace(
        "  provider: ai-router",
        `  provider: ${badDefault}`,
      );
      await withCustomHermesHome(yaml, async (hermesHome) => {
        const catalog = parseHermesProvidersAndModels(hermesHome);
        const policy = computePolicy(catalog, process.env);

        const res = resolveHermesInvocation({
          configProvider: "auto",
          configModel: "",
          catalog,
          policy,
        });
        expect(res).toMatchObject({
          ok: false,
          errorCode: "hermes_effective_provider_unverified",
          reason: "default_auto",
        });
      });
    }
  });

  test("restrictive mode never reaches prefix inference (cc/claude-sonnet-5 never routes to anthropic; RC-1f)", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      const res = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "cc/claude-sonnet-5",
        catalog,
        policy,
      });
      expect(res).toEqual({
        ok: true,
        provider: "ai-router",
        model: "cc/claude-sonnet-5",
        pinned: true,
        resolvedFrom: expect.any(String),
        warnings: [],
      });
      expect(res.ok && res.provider).not.toBe("anthropic");
    });
  });

  test("legacy mode omits --provider when unresolved and discards disallowed prefix inference", async () => {
    const legacyUnresolvedYaml = [
      "model:",
      "  default: custom-unknown-model",
      "",
    ].join("\n");
    await withCustomHermesHome(legacyUnresolvedYaml, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);
      expect(policy.mode).toBe("legacy");

      const unresolved = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "custom-unknown-model",
        catalog,
        policy,
      });
      expect(unresolved).toEqual({
        ok: true,
        provider: undefined,
        model: "custom-unknown-model",
        pinned: false,
        resolvedFrom: "auto",
        warnings: [],
      });

      const restrictedLegacyPolicy = {
        mode: "legacy" as const,
        allowedProviders: new Set(["openrouter"]),
      };
      const discardedInference = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "claude-sonnet-4",
        catalog,
        policy: restrictedLegacyPolicy,
      });
      expect(discardedInference).toEqual({
        ok: true,
        provider: undefined,
        model: "claude-sonnet-4",
        pinned: false,
        resolvedFrom: "auto",
        warnings: [],
      });
    });
  });
});
