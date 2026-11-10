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
});
