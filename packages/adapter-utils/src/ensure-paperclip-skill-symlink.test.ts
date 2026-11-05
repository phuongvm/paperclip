import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  linkPaperclipSkillDirectory,
} from "./server-utils.js";

describe("ensurePaperclipSkillSymlink", () => {
  it("creates, skips, repairs, and unlinks directory skill links on unprivileged hosts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-link-"));
    try {
      const sourceA = path.join(root, "source-a");
      const sourceB = path.join(root, "source-b");
      const targetDir = path.join(root, "skills");
      const target = path.join(targetDir, "paperclip");

      await fs.mkdir(sourceA, { recursive: true });
      await fs.writeFile(path.join(sourceA, "SKILL.md"), "# Skill A\n", "utf8");
      await fs.mkdir(sourceB, { recursive: true });
      await fs.writeFile(path.join(sourceB, "SKILL.md"), "# Skill B\n", "utf8");
      await fs.mkdir(targetDir, { recursive: true });

      const first = await ensurePaperclipSkillSymlink(sourceA, target);
      expect(first).toBe("created");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# Skill A\n");

      const second = await ensurePaperclipSkillSymlink(sourceA, target);
      expect(second).toBe("skipped");

      // Remove sourceA so target becomes dangling, then repair to sourceB
      await fs.rm(sourceA, { recursive: true, force: true });
      const repaired = await ensurePaperclipSkillSymlink(sourceB, target);
      expect(repaired).toBe("repaired");
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# Skill B\n");

      // Unlinking target must never delete files inside sourceB
      await fs.unlink(target);
      expect(await fs.readFile(path.join(sourceB, "SKILL.md"), "utf8")).toBe("# Skill B\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to NTFS junction with resolved absolute source when dir symlink throws EPERM on win32", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-eperm-"));
    try {
      const sourceA = path.join(root, "source-a");
      const targetDir = path.join(root, "skills");
      const target = path.join(targetDir, "paperclip");
      await fs.mkdir(sourceA, { recursive: true });
      await fs.writeFile(path.join(sourceA, "SKILL.md"), "# Junction Skill\n", "utf8");
      await fs.mkdir(targetDir, { recursive: true });

      const relativeSource = path.relative(targetDir, sourceA);
      const calls: Array<[string, string, string | undefined]> = [];

      const result = await ensurePaperclipSkillSymlink(
        relativeSource,
        target,
        (src, dst) =>
          linkPaperclipSkillDirectory(src, dst, {
            platform: "win32",
            symlink: async (s, d, type) => {
              calls.push([s, d, type]);
              if (type === "dir") {
                throw Object.assign(
                  new Error("EPERM: operation not permitted, symlink"),
                  { code: "EPERM" },
                );
              }
              await fs.symlink(
                s,
                d,
                process.platform === "win32" ? "junction" : "dir",
              );
            },
          }),
      );

      expect(result).toBe("created");
      expect(calls).toEqual([
        [relativeSource, target, "dir"],
        [path.resolve(sourceA), target, "junction"],
      ]);
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
        "# Junction Skill\n",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rethrows EPERM off win32 and rethrows non-EPERM errors on win32 without junction retry", async () => {
    const linuxCalls: string[] = [];
    await expect(
      linkPaperclipSkillDirectory("src-dir", "/tmp/dst-dir", {
        platform: "linux",
        symlink: async (_s, _d, type) => {
          linuxCalls.push(String(type));
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(linuxCalls).toEqual(["dir"]);

    const winCalls: string[] = [];
    await expect(
      linkPaperclipSkillDirectory("C:\\src-dir", "C:\\dst-dir", {
        platform: "win32",
        symlink: async (_s, _d, type) => {
          winCalls.push(String(type));
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(winCalls).toEqual(["dir"]);
  });
});
