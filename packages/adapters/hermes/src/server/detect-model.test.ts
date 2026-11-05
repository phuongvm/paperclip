import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { parseModelFromConfig, resolveProvider } from "./detect-model.js";
import { testEnvironment } from "./test.js";

const providerEnvKeys = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
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
        hermesCommand: "python3",
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
        hermesCommand: "python3",
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
        hermesCommand: "python3",
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
