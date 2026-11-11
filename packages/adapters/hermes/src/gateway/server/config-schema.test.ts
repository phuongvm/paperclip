import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigSchema } from "./config-schema.js";
import { resetGatewayCatalogCacheForTests } from "./model-options.js";

describe("hermes_gateway config schema (S3 Task 3.2)", () => {
  const originalEnv = { ...process.env };
  let tempHermesHome: string | null = null;

  beforeEach(() => {
    resetGatewayCatalogCacheForTests?.();
    tempHermesHome = mkdtempSync(join(tmpdir(), "hermes-gw-schema-"));
    delete process.env.PAPERCLIP_HERMES_GATEWAY_URL;
    delete process.env.PAPERCLIP_HERMES_GATEWAY_API_KEY;
    delete process.env.PAPERCLIP_HERMES_GATEWAY_PROFILE;
    delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
    process.env.HERMES_HOME = tempHermesHome;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    if (tempHermesHome) {
      rmSync(tempHermesHome, { recursive: true, force: true });
      tempHermesHome = null;
    }
  });

  it("populates provider (select, auto first, ${name} (${slug})), model (combobox with policy meta), and profile (text) from Tier 1 env gateway", async () => {
    process.env.PAPERCLIP_HERMES_GATEWAY_URL = "http://127.0.0.1:8642";
    process.env.PAPERCLIP_HERMES_GATEWAY_API_KEY = "env-operator-secret";
    process.env.PAPERCLIP_HERMES_GATEWAY_PROFILE = "coder";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: [
            {
              slug: "ai-router",
              name: "9Router Proxy",
              is_user_defined: true,
              models: ["cb-gemini-flash-high", "cc/claude-sonnet-5"],
            },
            {
              slug: "headroom-proxy",
              name: "Headroom Proxy",
              is_user_defined: true,
              models: ["cb-opus-4.6-thinking"],
            },
          ],
          provider: "ai-router",
          model: "cb-gemini-flash-high",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const schema = await getConfigSchema();
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));

    expect(byKey.profile).toBeDefined();
    expect(byKey.profile?.type).toBe("text");

    expect(byKey.provider).toBeDefined();
    expect(byKey.provider?.type).toBe("select");
    expect(byKey.provider?.options).toEqual([
      { value: "auto", label: "Auto" },
      { value: "ai-router", label: "9Router Proxy (ai-router)" },
      { value: "headroom-proxy", label: "Headroom Proxy (headroom-proxy)" },
    ]);

    expect(byKey.model).toBeDefined();
    expect(byKey.model?.type).toBe("combobox");
    expect(byKey.model?.meta).toEqual({
      providerModels: {
        "ai-router": ["cb-gemini-flash-high", "cc/claude-sonnet-5"],
        "headroom-proxy": ["cb-opus-4.6-thinking"],
      },
      providerLabels: {
        "ai-router": "9Router Proxy",
        "headroom-proxy": "Headroom Proxy",
      },
      allowedProviders: ["ai-router", "headroom-proxy"],
      defaultProvider: "ai-router",
      defaultModel: "cb-gemini-flash-high",
    });
    expect((byKey.model?.meta?.allowedProviders as string[]) ?? []).not.toContain("auto");
  });

  it("populates provider, model, and profile from Tier 1 host HERMES_HOME fallback when env gateway URL is unset", async () => {
    writeFileSync(
      join(tempHermesHome!, "config.yaml"),
      [
        "model:",
        "  provider: ai-router",
        "  default: cb-gemini-flash-high",
        "providers:",
        "  ai-router:",
        "    name: 9Router Proxy",
        "    enabled: true",
        "    models:",
        "      - cb-gemini-flash-high",
        "      - cc/claude-sonnet-5",
        "  headroom-proxy:",
        "    name: Headroom Proxy",
        "    enabled: true",
        "    models:",
        "      - cb-opus-4.6-thinking",
      ].join("\n"),
      "utf-8",
    );

    const schema = await getConfigSchema();
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));

    expect(byKey.profile?.type).toBe("text");
    expect(byKey.provider?.type).toBe("select");
    expect(byKey.provider?.options).toEqual([
      { value: "auto", label: "Auto" },
      { value: "ai-router", label: "9Router Proxy (ai-router)" },
      { value: "headroom-proxy", label: "Headroom Proxy (headroom-proxy)" },
    ]);

    expect(byKey.model?.type).toBe("combobox");
    expect(byKey.model?.meta).toEqual({
      providerModels: {
        "ai-router": ["cb-gemini-flash-high", "cc/claude-sonnet-5"],
        "headroom-proxy": ["cb-opus-4.6-thinking"],
      },
      providerLabels: {
        "ai-router": "9Router Proxy",
        "headroom-proxy": "Headroom Proxy",
      },
      allowedProviders: ["ai-router", "headroom-proxy"],
      defaultProvider: "ai-router",
      defaultModel: "cb-gemini-flash-high",
    });
    expect(byKey.provider?.hint ?? "").toMatch(/single[- ]gateway/i);
  });
});
