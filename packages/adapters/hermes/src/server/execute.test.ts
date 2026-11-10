import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Hello from stubbed hermes\nsession_id: sess-123\n",
      stderr: "",
      pid: 12345,
      startedAt: new Date(0).toISOString(),
    })),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

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
  "  headroom-proxy:",
  "    name: Headroom Proxy",
  "    enabled: true",
  "    base_url: http://192.168.100.110:8203/v1",
  "    key_env: HERMES_CUSTOM_HEADROOM_PROXY_API_KEY",
  "    models:",
  "      - cb-gemini-flash-high",
  "      - cb-opus-4.6-thinking",
  "",
].join("\n");

const SECRET_TOKEN_VALUE = "test-val-999";

describe("hermes_local execute provider authorization, pinning, and -m auto omission", () => {
  let tempHermesHome = "";
  const prevHermesHome = process.env.HERMES_HOME;
  const prevAllowed = process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHermesHome = await mkdtemp(join(tmpdir(), "hermes-exec-test-"));
    await mkdir(tempHermesHome, { recursive: true });
    await writeFile(join(tempHermesHome, "config.yaml"), ROUTER_CONFIG_YAML, "utf8");
    await writeFile(
      join(tempHermesHome, ".env"),
      ["HERMES_CUSTOM_AI_ROUTER_API_KEY", SECRET_TOKEN_VALUE].join("=") + "\n",
      "utf8",
    );
    process.env.HERMES_HOME = tempHermesHome;
    delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
  });

  afterEach(async () => {
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermesHome;
    if (prevAllowed === undefined) delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
    else process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS = prevAllowed;
    if (tempHermesHome) {
      await rm(tempHermesHome, { recursive: true, force: true });
    }
  });

  function makeExecCtx(configOverrides: Record<string, unknown> = {}) {
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    return {
      logs,
      ctx: {
        runId: "run-exec-test-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes",
          adapterType: "hermes_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          hermesCommand: process.execPath,
          timeoutSec: 60,
          graceSec: 5,
          ...configOverrides,
        },
        context: {
          issueId: "issue-1",
          wakeReason: "manual",
          paperclipWake: null,
        },
        onLog: vi.fn(async (stream: "stdout" | "stderr", chunk: string) => {
          logs.push({ stream, chunk });
        }),
        onMeta: vi.fn(async () => undefined),
        onSpawn: vi.fn(async () => undefined),
      },
    };
  }

  it.each(["", "auto", undefined])(
    "omits -m when model is %j and pins --provider ai-router (RC-4)",
    async (modelVal) => {
      const { ctx, logs } = makeExecCtx({
        provider: "auto",
        ...(modelVal !== undefined ? { model: modelVal } : {}),
      });
      const result = await execute(ctx as any);

      expect(result.exitCode).toBe(0);
      const mocked = vi.mocked(serverUtils.runChildProcess);
      expect(mocked).toHaveBeenCalledTimes(1);
      const args = mocked.mock.calls[0]![2] as string[];
      expect(args).not.toContain("-m");
      expect(args).not.toContain("auto");
      const providerIdx = args.indexOf("--provider");
      expect(providerIdx).toBeGreaterThanOrEqual(0);
      expect(args[providerIdx + 1]).toBe("ai-router");

      const allLogs = logs.map((l) => l.chunk).join("\n");
      expect(allLogs).not.toContain(SECRET_TOKEN_VALUE);
      expect(allLogs).not.toContain("Authorization");
    },
  );

  it("spawns with -m cb-opus-4.6-thinking --provider headroom-proxy when explicitly configured", async () => {
    const { ctx } = makeExecCtx({
      provider: "headroom-proxy",
      model: "cb-opus-4.6-thinking",
    });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls[0]![2] as string[];
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe("cb-opus-4.6-thinking");
    const pIdx = args.indexOf("--provider");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe("headroom-proxy");
  });

  it("pins --provider ai-router and never anthropic for {provider: 'auto', model: 'cc/claude-sonnet-5'} (RC-1f)", async () => {
    const { ctx } = makeExecCtx({
      provider: "auto",
      model: "cc/claude-sonnet-5",
    });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls[0]![2] as string[];
    expect(args).not.toContain("anthropic");
    const mIdx = args.indexOf("-m");
    expect(args[mIdx + 1]).toBe("cc/claude-sonnet-5");
    const pIdx = args.indexOf("--provider");
    expect(args[pIdx + 1]).toBe("ai-router");
  });

  it.each([
    {
      label: "disallowed provider",
      config: { provider: "anthropic", model: "cb-gemini-flash-high" },
      expectedCode: "hermes_provider_disallowed_by_policy",
    },
    {
      label: "unknown provider",
      config: { provider: "bogus-provider", model: "cb-gemini-flash-high" },
      expectedCode: "hermes_provider_unknown",
    },
    {
      label: "unverified effective provider",
      config: { provider: "auto", model: "" },
      setup: async (home: string) => {
        await writeFile(
          join(home, "config.yaml"),
          ROUTER_CONFIG_YAML.replace("  provider: ai-router", "  provider: auto"),
          "utf8",
        );
      },
      expectedCode: "hermes_effective_provider_unverified",
    },
  ])(
    "fails closed without spawning on $label and matches testEnvironment code ($expectedCode)",
    async ({ config, setup, expectedCode }) => {
      if (setup) await setup(tempHermesHome);

      const { ctx, logs } = makeExecCtx(config);
      const execResult = await execute(ctx as any);
      expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
      expect(execResult.exitCode).not.toBe(0);
      expect(execResult.errorMessage).toContain(expectedCode);

      const envResult = await testEnvironment({
        companyId: "company-1",
        adapterType: "hermes_local",
        config: {
          hermesCommand: process.execPath,
          ...config,
        },
      });
      expect(envResult.status).toBe("fail");
      expect(envResult.checks.map((c) => c.code)).toContain(expectedCode);

      const combinedLogs = logs.map((l) => l.chunk).join("\n");
      expect(combinedLogs).toContain(expectedCode);
      expect(combinedLogs).not.toContain(SECRET_TOKEN_VALUE);
      expect(combinedLogs).not.toContain("Bearer");
    },
  );
});
