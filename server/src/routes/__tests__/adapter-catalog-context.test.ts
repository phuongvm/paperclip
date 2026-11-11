import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAdapterCatalogContext,
  computeCatalogCacheKey,
} from "../../adapters/catalog-context.js";
import {
  listAdapterModels,
  refreshAdapterModels,
} from "../../adapters/registry.js";
import { adapterRoutes } from "../adapters.js";
import { errorHandler } from "../../middleware/error-handler.js";

describe("Tier 2 agent-scoped adapter catalog context (S3b Task 4.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes cacheKey = sha256(type, normalizedRoot, profile ?? '', secretId, secretVersion) without including secret value", () => {
    const secretVal = "raw-secret-api-key-value-never-in-hash";
    const key1 = computeCatalogCacheKey({
      adapterType: "hermes_gateway",
      normalizedRoot: "http://127.0.0.1:8642",
      profile: "coder",
      secretId: "sec-111",
      secretVersion: "3",
    });
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "hermes_gateway",
          "http://127.0.0.1:8642",
          "coder",
          "sec-111",
          "3",
        ]),
      )
      .digest("hex");
    expect(key1).toBe(expected);
    expect(key1).not.toContain(secretVal);
    expect(key1).not.toContain("sec-111");
  });

  it("rejects cross-company agent with 404/403 and adapter-type mismatch with 422 before resolving secrets or making network calls", async () => {
    const resolveSecretSpy = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const deps = {
      assertCompanyAccess: vi.fn(),
      assertCanReadAgentConfig: vi.fn().mockResolvedValue(undefined),
      getAgentById: vi.fn(async (id: string) => {
        if (id === "agent-other-company") {
          return {
            id,
            companyId: "company-other",
            adapterType: "hermes_gateway",
            adapterConfig: { apiBaseUrl: "http://127.0.0.1:8642" },
          };
        }
        if (id === "agent-wrong-type") {
          return {
            id,
            companyId: "company-1",
            adapterType: "claude_local",
            adapterConfig: {},
          };
        }
        return null;
      }),
      resolveAdapterConfigForRuntime: resolveSecretSpy,
    };

    await expect(
      buildAdapterCatalogContext(
        {
          req: {} as never,
          companyId: "company-1",
          adapterType: "hermes_gateway",
          agentId: "agent-other-company",
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      buildAdapterCatalogContext(
        {
          req: {} as never,
          companyId: "company-1",
          adapterType: "hermes_gateway",
          agentId: "agent-wrong-type",
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 422 });

    expect(resolveSecretSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves secret server-side in memory only, isolates schema cache per (type, ctx.cacheKey), and keeps non-opted-in adapters byte-identical", async () => {
    const rawSecretA = "secret-value-agent-A-do-not-leak";
    const rawSecretB = "secret-value-agent-B-do-not-leak";

    const deps = {
      assertCompanyAccess: vi.fn(),
      assertCanReadAgentConfig: vi.fn().mockResolvedValue(undefined),
      getAgentById: vi.fn(async (id: string) => {
        if (id === "agent-a") {
          return {
            id: "agent-a",
            companyId: "company-1",
            adapterType: "hermes_gateway",
            adapterConfig: {
              apiBaseUrl: "http://127.0.0.1:8642",
              profile: "coder",
              apiKey: { type: "secret_ref", secretId: "sec-a", version: 1 },
            },
          };
        }
        if (id === "agent-b") {
          return {
            id: "agent-b",
            companyId: "company-1",
            adapterType: "hermes_gateway",
            adapterConfig: {
              apiBaseUrl: "http://127.0.0.1:8642",
              profile: "reviewer",
              apiKey: { type: "secret_ref", secretId: "sec-b", version: 2 },
            },
          };
        }
        return null;
      }),
      resolveAdapterConfigForRuntime: vi.fn(
        async (_companyId: string, config: Record<string, unknown>) => ({
          ...config,
          apiKey:
            (config.apiKey as { secretId?: string })?.secretId === "sec-a"
              ? rawSecretA
              : rawSecretB,
        }),
      ),
    };

    const ctxA = await buildAdapterCatalogContext(
      {
        req: {} as never,
        companyId: "company-1",
        adapterType: "hermes_gateway",
        agentId: "agent-a",
      },
      deps,
    );
    const ctxB = await buildAdapterCatalogContext(
      {
        req: {} as never,
        companyId: "company-1",
        adapterType: "hermes_gateway",
        agentId: "agent-b",
      },
      deps,
    );

    expect(ctxA).not.toBeNull();
    expect(ctxB).not.toBeNull();
    expect(ctxA!.cacheKey).not.toBe(ctxB!.cacheKey);
    expect(ctxA!.cacheKey).not.toContain(rawSecretA);
    expect(ctxB!.cacheKey).not.toContain(rawSecretB);
    expect(ctxA!.authHeader).toBe(`Bearer ${rawSecretA}`);
    expect(ctxB!.authHeader).toBe(`Bearer ${rawSecretB}`);

    // Non-opted-in adapters return byte-identical models with and without ctx
    const codexWithoutCtx = await listAdapterModels("codex_local");
    const codexWithCtx = await listAdapterModels("codex_local", ctxA!);
    expect(codexWithCtx).toEqual(codexWithoutCtx);

    const codexRefreshWithoutCtx = await refreshAdapterModels("codex_local");
    const codexRefreshWithCtx = await refreshAdapterModels("codex_local", ctxA!);
    expect(codexRefreshWithCtx).toEqual(codexRefreshWithoutCtx);

    // Route-level test on GET /adapters/:type/config-schema?companyId=&agentId=
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/p/coder/api/model/options")) {
        return new Response(
          JSON.stringify({
            providers: [
              {
                slug: "router-a",
                name: "Router A",
                is_user_defined: true,
                models: ["model-a"],
              },
            ],
            provider: "router-a",
            model: "model-a",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/p/reviewer/api/model/options")) {
        return new Response(
          JSON.stringify({
            providers: [
              {
                slug: "router-b",
                name: "Router B",
                is_user_defined: true,
                models: ["model-b"],
              },
            ],
            provider: "router-b",
            model: "model-b",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
        userId: "user-1",
        companyIds: ["company-1"],
      };
      next();
    });
    app.use(
      "/api",
      adapterRoutes({
        buildCatalogContext: (input) => buildAdapterCatalogContext(input, deps),
      }),
    );
    app.use(errorHandler);

    const resA = await request(app).get(
      "/api/adapters/hermes_gateway/config-schema?companyId=company-1&agentId=agent-a",
    );
    const resB = await request(app).get(
      "/api/adapters/hermes_gateway/config-schema?companyId=company-1&agentId=agent-b",
    );
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const provA = resA.body.fields.find((f: { key: string }) => f.key === "provider");
    const provB = resB.body.fields.find((f: { key: string }) => f.key === "provider");
    expect(provA.options.map((o: { value: string }) => o.value)).toEqual([
      "auto",
      "router-a",
    ]);
    expect(provB.options.map((o: { value: string }) => o.value)).toEqual([
      "auto",
      "router-b",
    ]);
    expect(JSON.stringify(resA.body)).not.toContain(rawSecretA);
    expect(JSON.stringify(resB.body)).not.toContain(rawSecretB);
  });

  it("ignores companyId and agentId for non-opt-in adapters without failing (SP-02)", async () => {
    const buildCtxSpy = vi.fn();
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
        userId: "user-1",
        companyIds: ["company-1"],
      };
      next();
    });
    app.use(
      "/api",
      adapterRoutes({
        buildCatalogContext: buildCtxSpy,
      }),
    );
    app.use(errorHandler);

    // Requesting config-schema for codex_local (which does not opt in to agent-scoped catalog)
    // with nonexistent agentId should NOT call buildCatalogContext and should return 200 identically
    const resWithoutParams = await request(app).get("/api/adapters/codex_local/config-schema");
    const resWithParams = await request(app).get(
      "/api/adapters/codex_local/config-schema?companyId=company-1&agentId=nonexistent-agent",
    );

    expect(resWithoutParams.status).toBe(200);
    expect(resWithParams.status).toBe(200);
    expect(resWithParams.body).toEqual(resWithoutParams.body);
    expect(buildCtxSpy).not.toHaveBeenCalled();
  });
});
