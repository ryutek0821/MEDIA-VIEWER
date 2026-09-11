import { getExtension } from "../lib/media.ts";
import type { MediaRecord, RatingStore } from "./db.ts";
import { readPngTextChunk } from "./png-meta.ts";
import { DEFAULT_SETTLE_MS, scanMediaRoot, sha256File, type ScannedFile } from "./scan.ts";

const UPSERT_BATCH_SIZE = 50;

export interface SyncResult {
  files: number;
  hashed: number;
  failed: number;
}

export interface MediaLibraryOptions {
  mediaRoot: string;
  store: RatingStore;
  settleMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps the media catalogue in the store in step with the files on disk. */
export class MediaLibrary {
  readonly mediaRoot: string;
  readonly #store: RatingStore;
  readonly #settleMs: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #inflight: Promise<SyncResult | null> | null = null;
  #lastSyncedAt = Number.NEGATIVE_INFINITY;
  #lastError: string | null = null;

  constructor(options: MediaLibraryOptions) {
    this.mediaRoot = options.mediaRoot;
    this.#store = options.store;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((message) => console.error(message));
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** Concurrent callers share one scan. Resolves to null when the scan failed. */
  sync(): Promise<SyncResult | null> {
    if (!this.#inflight) {
      this.#inflight = this.#run().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async syncIfStale(maxAgeMs: number): Promise<void> {
    if (!this.#inflight && this.#now() - this.#lastSyncedAt < maxAgeMs) return;
    await this.sync();
  }

  async #run(): Promise<SyncResult | null> {
    const startedAt = this.#now();
    const seenAt = new Date(startedAt).toISOString();
    try {
      const files = await scanMediaRoot(this.mediaRoot, {
        now: startedAt,
        settleMs: this.#settleMs,
      });
      const cached = this.#store.cachedFiles();
      const batch: MediaRecord[] = [];
      const presentPaths: string[] = [];
      let hashed = 0;
      let failed = 0;
      const flush = () => {
        if (batch.length === 0) return;
        this.#store.upsertMedia(batch, seenAt);
        batch.length = 0;
      };

      for (const file of files) {
        const previous = cached.get(file.relPath);
        let record = previous;
        if (!previous || previous.sizeBytes !== file.sizeBytes || previous.mtimeMs !== file.mtimeMs) {
          try {
            record = await this.#readRecord(file);
            hashed += 1;
          } catch (error) {
            failed += 1;
            this.#log(`ファイルを読めませんでした: ${file.relPath}: ${errorMessage(error)}`);
          }
        }
        if (!record) continue;
        batch.push(record);
        presentPaths.push(record.relPath);
        // Flush in batches so a large first import becomes visible progressively.
        if (batch.length >= UPSERT_BATCH_SIZE) flush();
      }
      flush();
      this.#store.markMissingExcept(presentPaths);
      this.#lastError = null;
      return { files: presentPaths.length, hashed, failed };
    } catch (error) {
      this.#lastError = errorMessage(error);
      this.#log(`メディアフォルダを走査できませんでした: ${this.#lastError}`);
      return null;
    } finally {
      this.#lastSyncedAt = this.#now();
    }
  }

  async #readRecord(file: ScannedFile): Promise<MediaRecord> {
    const sha256 = await sha256File(file.absPath);
    const promptJson =
      getExtension(file.relPath) === "png"
        ? await readPngTextChunk(file.absPath, "prompt").catch(() => null)
        : null;
    return {
      relPath: file.relPath,
      sha256,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      promptJson,
    };
  }
}
