import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  // The reader never checks CRCs, so zeros keep fixtures simple.
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

export function textChunk(keyword: string, text: string): Buffer {
  return pngChunk(
    "tEXt",
    Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]),
  );
}

export function ztxtChunk(keyword: string, text: string): Buffer {
  return pngChunk(
    "zTXt",
    Buffer.concat([
      Buffer.from(keyword, "latin1"),
      Buffer.from([0, 0]),
      deflateSync(Buffer.from(text, "latin1")),
    ]),
  );
}

export function itxtChunk(keyword: string, text: string, compressed: boolean): Buffer {
  const body = Buffer.from(text, "utf8");
  return pngChunk(
    "iTXt",
    Buffer.concat([
      Buffer.from(keyword, "latin1"),
      Buffer.from([0, compressed ? 1 : 0, 0]),
      Buffer.from("ja", "latin1"),
      Buffer.from([0, 0]),
      compressed ? deflateSync(body) : body,
    ]),
  );
}

export function makePng(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", Buffer.alloc(13)),
    ...chunks,
    pngChunk("IDAT", Buffer.alloc(4)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
