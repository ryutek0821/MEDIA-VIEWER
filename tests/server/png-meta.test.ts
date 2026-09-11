// @vitest-environment node

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPngTextChunk } from "../../server/png-meta.ts";
import { itxtChunk, makePng, makeTempDir, textChunk, ztxtChunk } from "./helpers.ts";

describe("readPngTextChunk", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await makeTempDir("png-meta-");
    file = path.join(dir, "image.png");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the prompt from tEXt, zTXt and iTXt chunks", async () => {
    await writeFile(file, makePng([textChunk("workflow", "{}"), textChunk("prompt", '{"a":1}')]));
    expect(await readPngTextChunk(file, "prompt")).toBe('{"a":1}');

    await writeFile(file, makePng([ztxtChunk("prompt", "zipped")]));
    expect(await readPngTextChunk(file, "prompt")).toBe("zipped");

    await writeFile(file, makePng([itxtChunk("prompt", '{"text":"海辺"}', true)]));
    expect(await readPngTextChunk(file, "prompt")).toBe('{"text":"海辺"}');

    await writeFile(file, makePng([itxtChunk("prompt", "plain", false)]));
    expect(await readPngTextChunk(file, "prompt")).toBe("plain");
  });

  it("returns null for PNGs without a prompt, truncated files and non-PNG data", async () => {
    await writeFile(file, makePng([textChunk("workflow", "{}")]));
    expect(await readPngTextChunk(file, "prompt")).toBeNull();

    await writeFile(file, makePng([textChunk("prompt", '{"a":1}')]).subarray(0, 40));
    expect(await readPngTextChunk(file, "prompt")).toBeNull();

    await writeFile(file, "not a png");
    expect(await readPngTextChunk(file, "prompt")).toBeNull();
  });
});
