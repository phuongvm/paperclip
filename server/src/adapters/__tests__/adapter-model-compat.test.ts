import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAdapterModels, requireServerAdapter } from "../registry.js";

describe("AdapterModel backward-compatibility and lossless Hermes projection", () => {
  const prevHermesHome = process.env.HERMES_HOME;
  let tempHome = "";

  afterEach(async () => {
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermesHome;
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  it.each(["paperclip_runner", "opencode_local", "claude_local", "codex_local"])(
    "emits strictly {id, label} keys for non-Hermes adapter %s",
    async (adapterType) => {
      const staticModels = requireServerAdapter(adapterType).models ?? [];
      for (const m of staticModels) {
        expect(Object.keys(m).sort()).toEqual(["id", "label"]);
      }
    },
  );

  it("emits lossless {id, label, providerId, providerLabel, rawModelId, isUserDefined} for hermes_local via listAdapterModels", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hermes-compat-test-"));
    await mkdir(tempHome, { recursive: true });
    await writeFile(
      join(tempHome, "config.yaml"),
      [
        "model:",
        "  default: cb-gemini-flash-high",
        "  provider: ai-router",
        "providers:",
        "  ai-router:",
        "    name: 9Router Proxy",
        "    enabled: true",
        "    models:",
        "      - cb-gemini-flash-high",
        "      - cc/claude-sonnet-5",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env.HERMES_HOME = tempHome;

    const models = await listAdapterModels("hermes_local");
    expect(models).toEqual([
      {
        id: "ai-router/cb-gemini-flash-high",
        label: "cb-gemini-flash-high",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cb-gemini-flash-high",
        isUserDefined: true,
      },
      {
        id: "ai-router/cc/claude-sonnet-5",
        label: "cc/claude-sonnet-5",
        providerId: "ai-router",
        providerLabel: "9Router Proxy",
        rawModelId: "cc/claude-sonnet-5",
        isUserDefined: true,
      },
    ]);
  });
});
