import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VALID_PROVIDERS } from "../shared/constants.js";
import { createServerAdapter } from "../index.js";

const ROUTER_CONFIG_YAML = [
  "model:",
  "  default: cb-gemini-flash-high",
  "  provider: ai-router",
  "providers:",
  "  ai-router:",
  "    name: 9Router Proxy",
  "    enabled: true",
  "    models:",
  "      - cb-gemini-flash-high",
  "  headroom-proxy:",
  "    name: Headroom Proxy",
  "    enabled: true",
  "    models:",
  "      - cb-opus-4.6-thinking",
  "  disabled-router:",
  "    name: Disabled",
  "    enabled: false",
  "    models:",
  "      - x",
  "",
].join("\n");

describe("hermes_local getConfigSchema (S2)", () => {
  const prevHermesHome = process.env.HERMES_HOME;
  const prevAllowed = process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
  let tempHome = "";

  afterEach(async () => {
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermesHome;
    if (prevAllowed === undefined) delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;
    else process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS = prevAllowed;
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it("exposes provider options ['auto', 'ai-router', 'headroom-proxy'], no model field, and no meta.providerModels", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hermes-schema-test-"));
    await mkdir(tempHome, { recursive: true });
    await writeFile(join(tempHome, "config.yaml"), ROUTER_CONFIG_YAML, "utf8");
    process.env.HERMES_HOME = tempHome;
    delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;

    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const fieldsByKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));

    expect(fieldsByKey.provider).toBeDefined();
    expect(fieldsByKey.provider?.options?.map((o) => o.value)).toEqual([
      "auto",
      "ai-router",
      "headroom-proxy",
    ]);
    expect(fieldsByKey.model).toBeUndefined();
    for (const field of schema.fields) {
      expect((field as any).meta?.providerModels).toBeUndefined();
    }
  });

  it("degrades to built-in VALID_PROVIDERS without throwing on malformed YAML", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hermes-schema-bad-"));
    await mkdir(tempHome, { recursive: true });
    await writeFile(join(tempHome, "config.yaml"), ":::bad\t[yaml", "utf8");
    process.env.HERMES_HOME = tempHome;
    delete process.env.PAPERCLIP_HERMES_ALLOWED_PROVIDERS;

    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const fieldsByKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));

    expect(fieldsByKey.provider?.options?.map((o) => o.value)).toEqual([...VALID_PROVIDERS]);
    expect(fieldsByKey.model).toBeUndefined();
  });
});
