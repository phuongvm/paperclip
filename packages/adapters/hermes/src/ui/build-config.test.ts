import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "hermes_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildHermesConfig (RC-3 / RC-3b)", () => {
  it("merges every adapterSchemaValues key alongside model, timeoutSec, and persistSession", () => {
    const config = buildHermesConfig(
      makeValues({
        model: "cb-opus-4.6-thinking",
        adapterSchemaValues: {
          provider: "headroom-proxy",
          toolsets: "terminal,file,web",
          quiet: true,
          worktreeMode: true,
          checkpoints: true,
          verbose: false,
          paperclipApiUrl: "http://127.0.0.1:3100/api",
          graceSec: 15,
        },
      }),
    );

    expect(config).toMatchObject({
      provider: "headroom-proxy",
      model: "cb-opus-4.6-thinking",
      toolsets: "terminal,file,web",
      quiet: true,
      worktreeMode: true,
      checkpoints: true,
      verbose: false,
      paperclipApiUrl: "http://127.0.0.1:3100/api",
      graceSec: 15,
      timeoutSec: 1800,
      persistSession: true,
    });
  });

  it("transition matrix: normalizes selected option {providerId, rawModelId} into persisted {provider, model} without splitting raw slash ids", () => {
    // Case 2: selecting option with id "ai-router/cc/claude-sonnet-5" on create
    const c2 = buildHermesConfig({
      ...makeValues({
        model: "ai-router/cc/claude-sonnet-5",
        adapterSchemaValues: { provider: "auto" },
      }),
      selectedAdapterModel: {
        id: "ai-router/cc/claude-sonnet-5",
        label: "cc/claude-sonnet-5",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cc/claude-sonnet-5",
        isUserDefined: true,
      },
    } as any);
    expect(c2).toMatchObject({
      provider: "ai-router",
      model: "cc/claude-sonnet-5",
    });

    // Case 7: selecting option with rawModelId "ai-router/native"
    const c7 = buildHermesConfig({
      ...makeValues({
        model: "ai-router/ai-router/native",
        adapterSchemaValues: { provider: "ai-router" },
      }),
      selectedAdapterModel: {
        id: "ai-router/ai-router/native",
        label: "ai-router/native",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "ai-router/native",
        isUserDefined: true,
      },
    } as any);
    expect(c7).toMatchObject({
      provider: "ai-router",
      model: "ai-router/native",
    });

    // Case 3: free text "anthropic/claude-sonnet-4" with provider "auto" stays verbatim
    const c3 = buildHermesConfig(
      makeValues({
        model: "anthropic/claude-sonnet-4",
        adapterSchemaValues: { provider: "auto" },
      }),
    );
    expect(c3).toMatchObject({
      provider: "auto",
      model: "anthropic/claude-sonnet-4",
    });
  });
});
