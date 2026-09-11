// @vitest-environment node

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatingStore } from "../../server/db.ts";
import { MediaLibrary } from "../../server/library.ts";
import { makePng, makeTempDir, textChunk } from "./helpers.ts";

describe("MediaLibrary", () => {
  let root: string;
  let store: RatingStore;

  beforeEach(async () => {
    root = await makeTempDir("media-library-");
    store = RatingStore.open(":memory:");
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function createLibrary() {
    return new MediaLibrary({ mediaRoot: root, store, settleMs: 0, log: () => {} });
  }

  it("hashes only new or changed paths and keeps ratings across moves", async () => {
    await writeFile(path.join(root, "a.png"), makePng([textChunk("prompt", '{"1":{}}')]));
    const library = createLibrary();

    expect(await library.sync()).toEqual({ files: 1, hashed: 1, failed: 0 });
    expect(await library.sync()).toEqual({ files: 1, hashed: 0, failed: 0 });
    expect(store.exportRows()[0].promptJson).toBe('{"1":{}}');

    const [item] = store.queue("all");
    store.setRating(item.sha256, "keep", null, "2026-09-11T00:00:00.000Z");
    await mkdir(path.join(root, "moved"));
    await rename(path.join(root, "a.png"), path.join(root, "moved", "a.png"));

    expect(await library.sync()).toEqual({ files: 1, hashed: 1, failed: 0 });
    expect(store.queue("all").map((entry) => [entry.relPath, entry.rating])).toEqual([
      ["moved/a.png", "keep"],
    ]);
  });

  it("keeps the catalogue and reports an error when the folder cannot be read", async () => {
    await writeFile(path.join(root, "a.mp4"), "video");
    const library = createLibrary();
    await library.sync();

    await rm(root, { recursive: true, force: true });

    expect(await library.sync()).toBeNull();
    expect(library.lastError).toMatch(/ENOENT/);
    expect(store.stats().total).toBe(1);
  });
});
