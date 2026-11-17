import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("project environment migration hash contract", () => {
  it.each([
    ["0466_drop_project_environment.sql", "dropSha256", "07ca1c666c6471fdb9ce7a0a5fb31bf1a074138466fa8daae50b53199b8e0d7c"],
    ["0467_fair_human_torch.sql", "repairSha256", "50ce0eb2567570b098bea1de92fe6a220d139e4ba83438195fbbad1be51e31a1"],
  ])("preserves the published hash and guard for %s", async (file, key, publishedHash) => {
    const content = await readFile(new URL(`./migrations/${file}`, import.meta.url));
    expect(createHash("sha256").update(content).digest("hex")).toBe(publishedHash);
    const client = await readFile(new URL("./client.ts", import.meta.url), "utf8");
    expect(client).toContain(`${key}: "${publishedHash}"`);
  });
});
