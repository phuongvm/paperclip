import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePaperclipSkillSymlink } from "./server-utils.js";

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
});
