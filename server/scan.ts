import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { getMediaKind, type MediaKind } from "../lib/media.ts";

/** Files modified more recently than this are probably still being copied in. */
export const DEFAULT_SETTLE_MS = 60_000;

export interface ScannedFile {
  relPath: string;
  absPath: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ScanOptions {
  now?: number;
  settleMs?: number;
}

/**
 * Lists supported media below `root`. Any read error aborts the whole scan so a
 * transient failure never makes existing files look deleted.
 */
export async function scanMediaRoot(
  root: string,
  options: ScanOptions = {},
): Promise<ScannedFile[]> {
  const now = options.now ?? Date.now();
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const files: ScannedFile[] = [];

  async function walk(directory: string, relDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Hidden entries cover .DS_Store and temp files; symlinks could point outside the root.
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absPath = path.join(directory, entry.name);
      const relPath = relDirectory ? `${relDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      const kind = entry.isFile() ? getMediaKind(entry.name) : null;
      if (!kind) continue;
      const stats = await lstat(absPath);
      // mtime has sub-millisecond precision and can be slightly ahead of `now`.
      if (!stats.isFile() || (settleMs > 0 && now - stats.mtimeMs < settleMs)) continue;
      files.push({
        relPath,
        absPath,
        kind,
        sizeBytes: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
      });
    }
  }

  await walk(root, "");
  return files.sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0,
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
