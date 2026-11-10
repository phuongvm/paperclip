import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listHermesGatewayModels,
  parseModelOptionsPayload,
  refreshHermesGatewayModels,
  resetGatewayCatalogCacheForTests,
} from "./model-options.js";
import { testEnvironment } from "./test.js";

const REDACTED_MODEL_OPTIONS_PAYLOAD = {
  providers: [
    {
      slug: "ai-router",
      name: "9Router Proxy",
      is_current: true,
      is_user_defined: true,
      models: ["cb-gemini-flash-high", "cc/claude-sonnet-5"],
      total_models: 2,
      source: "providers",
    },
    {
      slug: "headroom-proxy",
      name: "Headroom Proxy",
      is_current: false,
      is_user_defined: true,
      models: ["cb-opus-4.6-thinking"],
      total_models: 1,
      source: "providers",
    },
    {
      slug: "anthropic",
      name: "Anthropic",
      is_current: false,
      is_user_defined: false,
      models: ["claude-sonnet-4-5"],
      total_models: 1,
      source: "builtin",
    },
  ],
  model: "cb-gemini-flash-high",
  provider: "ai-router",
};

describe("hermes_gateway /api/model/options parser and Tier 1 catalog (S3 Task 3.3)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetGatewayCatalogCacheForTests?.();
    delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
    process.env.PAPERCLIP_HERMES_GATEWAY_URL = "http://127.0.0.1:8642";
    process.env.PAPERCLIP_HERMES_GATEWAY_API_KEY = "super-secret-operator-key";
    delete process.env.PAPERCLIP_HERMES_GATEWAY_PROFILE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps payload keyed by slug (never name) and sets configuredProviders from is_user_defined", () => {
    const parsed = parseModelOptionsPayload(REDACTED_MODEL_OPTIONS_PAYLOAD);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.catalog.modelsByProvider["ai-router"]).toEqual([
      "cb-gemini-flash-high",
      "cc/claude-sonnet-5",
    ]);
    expect(parsed.catalog.modelsByProvider["9Router Proxy"]).toBeUndefined();
    expect(parsed.catalog.configuredProviders).toEqual(["ai-router", "headroom-proxy"]);
    expect(parsed.catalog.defaultProvider).toBe("ai-router");
    expect(parsed.catalog.defaultModel).toBe("cb-gemini-flash-high");
  });

  it("rejects flat array, missing providers array, or duplicate slug as catalog failure (not [] success) and skips rows without string slug", () => {
    expect(parseModelOptionsPayload([])).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
    expect(parseModelOptionsPayload({ model: "x" })).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
    expect(
      parseModelOptionsPayload({
        providers: [
          { slug: "ai-router", name: "A", is_user_defined: true, models: ["m1"] },
          { slug: "AI-Router", name: "B", is_user_defined: true, models: ["m2"] },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate_slug",
    });

    const withSkippedRow = parseModelOptionsPayload({
      providers: [
        { slug: 123, name: "BadRow", models: ["ignored"] },
        { name: "NoSlug", models: ["ignored"] },
        { slug: "ai-router", name: "9Router", is_user_defined: true, models: ["m1"] },
      ],
      provider: "ai-router",
      model: "m1",
    });
    expect(withSkippedRow.ok).toBe(true);
    if (withSkippedRow.ok) {
      expect(withSkippedRow.catalog.providers.map((p: { id: string }) => p.id)).toEqual(["ai-router"]);
    }
  });

  it("requests include_unconfigured=false with 3s timeout, caches for 60s keyed by (normalizedRoot, profile), and bypasses/forwards refresh=1", async () => {
    vi.useFakeTimers();
    process.env.PAPERCLIP_HERMES_GATEWAY_PROFILE = "coder";

    const seenCalls: Array<{ url: string; auth: string | null; hasSignal: boolean }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenCalls.push({
        url: String(input),
        auth:
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
        hasSignal: Boolean(init?.signal),
      });
      return new Response(JSON.stringify(REDACTED_MODEL_OPTIONS_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const first = await listHermesGatewayModels();
    const second = await listHermesGatewayModels();

    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]!.url).toBe(
      "http://127.0.0.1:8642/p/coder/api/model/options?include_unconfigured=false",
    );
    expect(seenCalls[0]!.hasSignal).toBe(true);
    expect(first).toEqual(second);
    expect(first.map((m: { id: string }) => m.id)).toEqual([
      "ai-router/cb-gemini-flash-high",
      "ai-router/cc/claude-sonnet-5",
      "headroom-proxy/cb-opus-4.6-thinking",
    ]);

    // Different profile -> cache miss
    process.env.PAPERCLIP_HERMES_GATEWAY_PROFILE = "reviewer";
    await listHermesGatewayModels();
    expect(seenCalls).toHaveLength(2);
    expect(seenCalls[1]!.url).toBe(
      "http://127.0.0.1:8642/p/reviewer/api/model/options?include_unconfigured=false",
    );

    // Explicit refresh bypasses TTL and forwards refresh=1
    await refreshHermesGatewayModels();
    expect(seenCalls).toHaveLength(3);
    expect(seenCalls[2]!.url).toBe(
      "http://127.0.0.1:8642/p/reviewer/api/model/options?include_unconfigured=false&refresh=1",
    );

    // Advance past 60s TTL -> re-fetches
    vi.advanceTimersByTime(61_000);
    await listHermesGatewayModels();
    expect(seenCalls).toHaveLength(4);
  });

  it("returns last-known-good on 401/5xx/timeout, else [], surfaces hermes_gateway_catalog_unauthorized in testEnvironment on 401, and logs only outcome code + host", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let statusToReturn = 200;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (statusToReturn === 200) {
        return new Response(JSON.stringify(REDACTED_MODEL_OPTIONS_PAYLOAD), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: statusToReturn,
      });
    });

    // Warm cache with LKG
    const warm = await listHermesGatewayModels();
    expect(warm.length).toBe(3);

    // Now force 503 on refresh -> returns LKG
    statusToReturn = 503;
    const degraded = await refreshHermesGatewayModels();
    expect(degraded).toEqual(warm);

    // Cold cache + 401 -> returns []
    resetGatewayCatalogCacheForTests?.();
    statusToReturn = 401;
    const coldEmpty = await listHermesGatewayModels();
    expect(coldEmpty).toEqual([]);

    // testEnvironment surfaces hermes_gateway_catalog_unauthorized on 401
    const envRes = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "super-secret-operator-key",
        provider: "ai-router",
        model: "cb-gemini-flash-high",
      },
    });
    expect(
      envRes.checks.some((c) => c.code === "hermes_gateway_catalog_unauthorized"),
    ).toBe(true);

    // Logs must never contain the secret key, only code + host
    const logText = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logText).not.toContain("super-secret-operator-key");
  });
});
