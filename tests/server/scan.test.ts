// @vitest-environment node

import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanMediaRoot, sha256File } from "../../server/scan.ts";
import { makeTempDir } from "./helpers.ts";

describe("scanMediaRoot", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir("media-scan-");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists settled media and skips hidden, symlinked, unsupported and fresh files", async () => {
    const settled = new Date("2026-09-11T00:00:00Z");
    const now = settled.getTime() + 120_000;
    await mkdir(path.join(root, "batch"));
    await mkdir(path.join(root, ".cache"));
    const files = ["batch/b.png", "a.mp4", "notes.json", ".hidden.png", ".cache/c.png"];
    for (const file of files) {
      await writeFile(path.join(root, file), "data");
      await utimes(path.join(root, file), settled, settled);
    }
    await writeFile(path.join(root, "copying.png"), "partial");
    const recent = new Date(now - 1_000);
    await utimes(path.join(root, "copying.png"), recent, recent);
    await symlink(path.join(root, "a.mp4"), path.join(root, "link.mp4"));

    const scanned = await scanMediaRoot(root, { now });

    expect(scanned.map((file) => [file.relPath, file.kind, file.sizeBytes])).toEqual([
      ["a.mp4", "video", 4],
      ["batch/b.png", "image", 4],
    ]);
    expect(scanned[0].mtimeMs).toBe(settled.getTime());
  });

  it("fails instead of returning a partial list when the root is missing", async () => {
    await expect(scanMediaRoot(path.join(root, "missing"))).rejects.toThrow(/ENOENT/);
  });

  it("hashes file contents with SHA-256", async () => {
    const file = path.join(root, "hello.png");
    await writeFile(file, "hello");
    expect(await sha256File(file)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
