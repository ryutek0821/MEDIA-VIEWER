import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT_CHUNK_BYTES = 16 * 1024 * 1024;
const TEXT_CHUNK_TYPES = new Set(["tEXt", "zTXt", "iTXt"]);

interface TextChunk {
  keyword: string;
  text: string;
}

export function decodeTextChunk(type: string, data: Buffer): TextChunk | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd <= 0) return null;
  const keyword = data.toString("latin1", 0, keywordEnd);

  if (type === "tEXt") {
    return { keyword, text: data.toString("latin1", keywordEnd + 1) };
  }
  if (type === "zTXt") {
    if (data[keywordEnd + 1] !== 0) return null;
    return { keyword, text: inflateSync(data.subarray(keywordEnd + 2)).toString("latin1") };
  }
  if (type === "iTXt") {
    const compressed = data[keywordEnd + 1] === 1;
    if (compressed && data[keywordEnd + 2] !== 0) return null;
    const languageEnd = data.indexOf(0, keywordEnd + 3);
    if (languageEnd < 0) return null;
    const translatedKeywordEnd = data.indexOf(0, languageEnd + 1);
    if (translatedKeywordEnd < 0) return null;
    const body = data.subarray(translatedKeywordEnd + 1);
    return { keyword, text: (compressed ? inflateSync(body) : body).toString("utf8") };
  }
  return null;
}

/**
 * Returns the text stored under `keyword` in a PNG text chunk (ComfyUI writes its
 * generation graph as "prompt"). Only chunk headers are read for image data.
 */
export async function readPngTextChunk(
  filePath: string,
  keyword: string,
): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(8);
    const signature = await handle.read(header, 0, 8, 0);
    if (signature.bytesRead < 8 || !header.equals(PNG_SIGNATURE)) return null;

    let position = 8;
    for (;;) {
      const { bytesRead } = await handle.read(header, 0, 8, position);
      if (bytesRead < 8) return null;
      const length = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "IEND") return null;

      if (TEXT_CHUNK_TYPES.has(type) && length <= MAX_TEXT_CHUNK_BYTES) {
        const data = Buffer.alloc(length);
        const chunk = await handle.read(data, 0, length, position + 8);
        if (chunk.bytesRead < length) return null;
        try {
          const decoded = decodeTextChunk(type, data);
          if (decoded?.keyword === keyword) return decoded.text;
        } catch {
          // A corrupt compressed chunk should not hide a later valid one.
        }
      }
      position += 12 + length;
    }
  } finally {
    await handle.close();
  }
}
