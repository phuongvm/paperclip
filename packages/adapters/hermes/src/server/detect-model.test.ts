import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { VALID_PROVIDERS } from "../shared/constants.js";
import { createServerAdapter } from "../index.js";
import {
  computePolicy,
  normalizeSlug,
  parseHermesProvidersAndModels,
} from "./catalog.js";
import { parseModelFromConfig, resolveHermesHome, resolveProvider } from "./detect-model.js";
import {
  composeHermesOptionId,
  resolveHermesInvocation,
  selectionFromOption,
} from "./resolver.js";
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
        "HERMES_CUSTOM_AI_ROUTER_API_KEY=test-key-1",
        "HERMES_CUSTOM_HEADROOM_PROXY_API_KEY=test-key-2",
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

describe("catalog", () => {
  test("parses dict and list models, skips enabled:false, supports legacy custom_providers, promotes default first, and never emits secret fields", async () => {
    const yamlWithLegacy = [
      ROUTER_CONFIG_YAML.trimEnd(),
      "custom_providers:",
      "  custom-legacy:",
      "    name: Custom Legacy Provider",
      "    enabled: true",
      "    base_url: http://127.0.0.1:9000/v1",
      "    api_key: inline-key-1",
      "    key_env: CUSTOM_LEGACY_KEY_ENV",
      "    models:",
      "      - legacy-custom-m1",
      "",
    ].join("\n");

    await withCustomHermesHome(yamlWithLegacy, async (hermesHome) => {
      const resolvedPath = resolveHermesHome();
      expect(resolvedPath).toBe(hermesHome);
      expect(resolvedPath).not.toContain(".hermes");

      const catalog = parseHermesProvidersAndModels(hermesHome);
      expect(catalog.defaultProviderReadable).toBe(true);
      expect(catalog.defaultProvider).toBe("ai-router");
      expect(catalog.defaultModel).toBe("cb-gemini-flash-high");
      expect(catalog.configuredProviders).toEqual([
        "ai-router",
        "headroom-proxy",
        "custom-legacy",
      ]);
      expect(catalog.configuredProviders).not.toContain("legacy-router");
      expect(catalog.modelsByProvider["ai-router"]).toEqual([
        "cb-gemini-flash-high",
        "cc/claude-sonnet-5",
        "ai-router/native",
      ]);
      expect(catalog.modelsByProvider["headroom-proxy"]).toEqual([
        "cb-gemini-flash-high",
        "cc/claude-sonnet-5",
        "cb-opus-4.6-thinking",
      ]);
      expect(catalog.modelsByProvider["custom-legacy"]).toEqual(["legacy-custom-m1"]);

      const serialized = JSON.stringify(catalog);
      expect(serialized).not.toContain("inline-key-1");
      expect(serialized).not.toContain("test-key-1");
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("apiKey");

      const adapter = createServerAdapter();
      expect(typeof adapter.listModels).toBe("function");
      expect(typeof adapter.refreshModels).toBe("function");

      const models = await adapter.listModels!();
      expect(models[0]).toEqual({
        id: "ai-router/cb-gemini-flash-high",
        label: "cb-gemini-flash-high",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cb-gemini-flash-high",
        isUserDefined: true,
      });
      expect(
        models.every(
          (m: any) =>
            typeof m.providerId === "string" &&
            typeof m.providerLabel === "string" &&
            typeof m.rawModelId === "string" &&
            m.isUserDefined === true,
        ),
      ).toBe(true);
    });
  });

  test("records defaultProviderReadable=false on malformed YAML without throwing and uses mtime cache bypassed by refreshModels", async () => {
    await withCustomHermesHome(":::malformed yaml\t[unclosed", async (hermesHome) => {
      const badCatalog = parseHermesProvidersAndModels(hermesHome);
      expect(badCatalog.defaultProviderReadable).toBe(false);
      expect(badCatalog.configuredProviders).toEqual([]);

      const adapter = createServerAdapter();
      await expect(adapter.listModels!()).resolves.toEqual([]);
    });

    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const adapter = createServerAdapter();
      const firstList = await adapter.listModels!();
      expect(firstList.map((m) => m.id)).not.toContain("ai-router/newly-added-model");

      const updatedYaml = ROUTER_CONFIG_YAML.replace(
        "      ai-router/native:\n        name: Native Router Model",
        "      ai-router/native:\n        name: Native Router Model\n      newly-added-model:\n        name: Newly Added Model",
      );
      await writeFile(join(hermesHome, "config.yaml"), updatedYaml, "utf8");

      const refreshedList = await adapter.refreshModels!();
      expect(refreshedList.map((m) => m.id)).toContain("ai-router/newly-added-model");
    });
  });
});

describe("transition matrix", () => {
  test("covers all 9 cases of the D2 transition matrix including Case 9 ambiguous legacy composite, Case 7 ai-router/native verbatim, Case 5 warning, and multi-catalog tie-break", async () => {
    await withCustomHermesHome(ROUTER_CONFIG_YAML, async (hermesHome) => {
      const catalog = parseHermesProvidersAndModels(hermesHome);
      const policy = computePolicy(catalog, process.env);

      // Case 1: Create pick ai-router + cb-gemini-flash-high
      const opt1 = {
        id: "ai-router/cb-gemini-flash-high",
        label: "cb-gemini-flash-high",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cb-gemini-flash-high",
        isUserDefined: true,
      };
      expect(selectionFromOption(opt1)).toEqual({
        provider: "ai-router",
        model: "cb-gemini-flash-high",
      });
      expect(
        composeHermesOptionId(
          { provider: "ai-router", model: "cb-gemini-flash-high" },
          catalog,
        ),
      ).toBe("ai-router/cb-gemini-flash-high");
      expect(
        resolveHermesInvocation({
          configProvider: "ai-router",
          configModel: "cb-gemini-flash-high",
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "ai-router",
        model: "cb-gemini-flash-high",
        pinned: true,
      });

      // Case 2: Slash model cc/claude-sonnet-5 under ai-router (never anthropic)
      const opt2 = {
        id: "ai-router/cc/claude-sonnet-5",
        label: "cc/claude-sonnet-5",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cc/claude-sonnet-5",
        isUserDefined: true,
      };
      expect(selectionFromOption(opt2)).toEqual({
        provider: "ai-router",
        model: "cc/claude-sonnet-5",
      });
      expect(
        resolveHermesInvocation({
          configProvider: "ai-router",
          configModel: "cc/claude-sonnet-5",
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "ai-router",
        model: "cc/claude-sonnet-5",
        pinned: true,
      });

      // Case 3: Free text anthropic/claude-sonnet-4 with provider auto (built-in prefix never decoded under router policy)
      expect(
        resolveHermesInvocation({
          configProvider: "auto",
          configModel: "anthropic/claude-sonnet-4",
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "ai-router",
        model: "anthropic/claude-sonnet-4",
        pinned: true,
      });

      // Case 4: Provider switched ai-router -> headroom-proxy when model is in both
      expect(
        resolveHermesInvocation({
          configProvider: "headroom-proxy",
          configModel: "cb-gemini-flash-high",
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "headroom-proxy",
        model: "cb-gemini-flash-high",
        pinned: true,
        warnings: [],
      });

      // Case 5: Provider switched to one lacking the model -> sent verbatim (Rule A) + hermes_model_not_in_provider_catalog warning
      const case5 = resolveHermesInvocation({
        configProvider: "ai-router",
        configModel: "cb-opus-4.6-thinking",
        catalog,
        policy,
      });
      expect(case5).toEqual({
        ok: true,
        provider: "ai-router",
        model: "cb-opus-4.6-thinking",
        pinned: true,
        resolvedFrom: "adapterConfig",
        warnings: ["hermes_model_not_in_provider_catalog"],
      });

      // Case 6: Model "" or "auto" -> -m omitted, --provider ai-router pinned
      for (const emptyOrAuto of ["", "auto"]) {
        expect(
          resolveHermesInvocation({
            configProvider: "auto",
            configModel: emptyOrAuto,
            catalog,
            policy,
          }),
        ).toEqual({
          ok: true,
          provider: "ai-router",
          model: undefined,
          pinned: true,
          resolvedFrom: "hermesConfig",
          warnings: [],
        });
      }

      // Case 7: Round-trip raw id starting with a slug {provider: "ai-router", model: "ai-router/native"} -> verbatim (Rule A, never split)
      expect(
        resolveHermesInvocation({
          configProvider: "ai-router",
          configModel: "ai-router/native",
          catalog,
          policy,
        }),
      ).toEqual({
        ok: true,
        provider: "ai-router",
        model: "ai-router/native",
        pinned: true,
        resolvedFrom: "adapterConfig",
        warnings: [],
      });

      // Case 8: Pick headroom-proxy/cb-gemini-flash-high, then change Provider select to ai-router (last explicit write wins)
      const picked = selectionFromOption({
        id: "headroom-proxy/cb-gemini-flash-high",
        label: "cb-gemini-flash-high",
        providerId: "headroom-proxy",
        providerLabel: "Headroom Proxy",
        rawModelId: "cb-gemini-flash-high",
        isUserDefined: true,
      });
      const overridden = { ...picked, provider: "ai-router" };
      expect(
        resolveHermesInvocation({
          configProvider: overridden.provider,
          configModel: overridden.model,
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "ai-router",
        model: "cb-gemini-flash-high",
      });

      // Multi-catalog tie-break when provider omitted and model is in both ai-router and headroom-proxy -> host default (ai-router) wins
      expect(
        resolveHermesInvocation({
          configProvider: undefined,
          configModel: "cb-gemini-flash-high",
          catalog,
          policy,
        }),
      ).toMatchObject({
        ok: true,
        provider: "ai-router",
        model: "cb-gemini-flash-high",
        resolvedFrom: "hermesConfig",
      });

      // Rule B legacy composite decode when provider omitted and raw id is NOT in any allowed catalog
      const legacyCatalog = {
        ...catalog,
        modelsByProvider: {
          "ai-router": ["only-in-ai-router"],
          "headroom-proxy": ["only-in-headroom"],
        },
      };
      expect(
        resolveHermesInvocation({
          configProvider: undefined,
          configModel: "ai-router/only-in-ai-router",
          catalog: legacyCatalog,
          policy,
        }),
      ).toEqual({
        ok: true,
        provider: "ai-router",
        model: "only-in-ai-router",
        pinned: true,
        resolvedFrom: "legacyComposite",
        warnings: [],
      });

      // Case 9 (R3-I01): legacy record {model: "ai-router/native"} with provider omitted, host default headroom-proxy lacks that id,
      // and ai-router catalog has BOTH "ai-router/native" (direct member) and "native" (making Rule B decode also catalog-valid)
      const case9Catalog = {
        ...catalog,
        defaultProvider: "headroom-proxy",
        modelsByProvider: {
          "ai-router": ["ai-router/native", "native", "cb-gemini-flash-high"],
          "headroom-proxy": ["cb-gemini-flash-high"],
        },
      };
      const case9 = resolveHermesInvocation({
        configProvider: undefined,
        configModel: "ai-router/native",
        catalog: case9Catalog,
        policy,
      });
      expect(case9).toEqual({
        ok: true,
        provider: "ai-router",
        model: "ai-router/native",
        pinned: true,
        resolvedFrom: "catalogMembership",
        warnings: ["hermes_model_ambiguous_legacy_composite"],
      });

      // SP-01: Rule B decodes when provider is explicit 'auto' as well as omitted
      const ruleBAutoCatalog = {
        ...catalog,
        defaultProvider: "ai-router",
        modelsByProvider: {
          "ai-router": ["native-a", "m"],
          "headroom-proxy": ["native-b", "m"],
        },
      };
      const ruleBAuto = resolveHermesInvocation({
        configProvider: "auto",
        configModel: "headroom-proxy/m",
        catalog: ruleBAutoCatalog,
        policy,
      });
      expect(ruleBAuto).toEqual({
        ok: true,
        provider: "headroom-proxy",
        model: "m",
        pinned: true,
        resolvedFrom: "legacyComposite",
        warnings: [],
      });
    });
  });
});
