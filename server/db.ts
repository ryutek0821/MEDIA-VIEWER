import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MediaKind, QueueItem, QueueMode, Rating, RatingStats } from "../lib/media.ts";

export interface MediaRecord {
  relPath: string;
  sha256: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  promptJson: string | null;
}

export interface PresentFile {
  relPath: string;
  kind: MediaKind;
}

export interface RatingEvent {
  relPath: string;
  rating: Rating | null;
  createdAt: string;
  ratedBy: string | null;
}

export interface ExportRow extends MediaRecord {
  missing: boolean;
  rating: Rating | null;
  ratedAt: string | null;
  updatedAt: string | null;
  ratedBy: string | null;
}

interface MediaRow {
  rel_path: string;
  sha256: string;
  kind: MediaKind;
  size_bytes: number;
  mtime_ms: number;
  prompt_json: string | null;
}

interface QueueRow {
  sha256: string;
  rel_path: string;
  kind: MediaKind;
  size_bytes: number;
  mtime_ms: number;
  rating: Rating | null;
  updated_at: string | null;
}

interface ExportDbRow extends MediaRow {
  missing: number;
  rating: Rating | null;
  rated_at: string | null;
  updated_at: string | null;
  rated_by: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  rel_path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  prompt_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS media_sha256 ON media (sha256);

CREATE TABLE IF NOT EXISTS ratings (
  sha256 TEXT PRIMARY KEY,
  rating TEXT NOT NULL CHECK (rating IN ('reject', 'keep', 'hold')),
  rel_path TEXT NOT NULL,
  rated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rated_by TEXT
);

CREATE TABLE IF NOT EXISTS rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  rating TEXT CHECK (rating IS NULL OR rating IN ('reject', 'keep', 'hold')),
  created_at TEXT NOT NULL,
  rated_by TEXT
);
CREATE INDEX IF NOT EXISTS rating_events_sha256 ON rating_events (sha256);
`;

const UPSERT_MEDIA = `
INSERT INTO media (rel_path, sha256, kind, size_bytes, mtime_ms, prompt_json, first_seen_at, last_seen_at, missing)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT (rel_path) DO UPDATE SET
  sha256 = excluded.sha256,
  kind = excluded.kind,
  size_bytes = excluded.size_bytes,
  mtime_ms = excluded.mtime_ms,
  prompt_json = excluded.prompt_json,
  last_seen_at = excluded.last_seen_at,
  missing = 0`;

// One queue entry per distinct content; duplicates at other paths share its rating.
const QUEUE = `
WITH present AS (
  SELECT sha256, MIN(rel_path) AS rel_path FROM media WHERE missing = 0 GROUP BY sha256
)
SELECT m.sha256, m.rel_path, m.kind, m.size_bytes, m.mtime_ms, r.rating, r.updated_at
FROM present p
JOIN media m ON m.rel_path = p.rel_path
LEFT JOIN ratings r ON r.sha256 = p.sha256
WHERE ? = 'all' OR (? = 'unrated' AND r.rating IS NULL) OR (? = 'hold' AND r.rating = 'hold')
ORDER BY m.mtime_ms, m.rel_path`;

const STATS = `
WITH present AS (SELECT DISTINCT sha256 FROM media WHERE missing = 0)
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(r.rating IS NULL), 0) AS unrated,
  COALESCE(SUM(r.rating = 'reject'), 0) AS reject,
  COALESCE(SUM(r.rating = 'keep'), 0) AS keep,
  COALESCE(SUM(r.rating = 'hold'), 0) AS hold
FROM present p
LEFT JOIN ratings r ON r.sha256 = p.sha256`;

function toMediaRecord(row: MediaRow): MediaRecord {
  return {
    relPath: row.rel_path,
    sha256: row.sha256,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    promptJson: row.prompt_json,
  };
}

/** Ratings are keyed by content SHA-256 so they survive renames and moves. */
export class RatingStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  static open(filename: string): RatingStore {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    return new RatingStore(new DatabaseSync(filename));
  }

  close(): void {
    this.#db.close();
  }

  cachedFiles(): Map<string, MediaRecord> {
    const rows = this.#db
      .prepare("SELECT rel_path, sha256, kind, size_bytes, mtime_ms, prompt_json FROM media")
      .all() as unknown as MediaRow[];
    return new Map(rows.map((row) => [row.rel_path, toMediaRecord(row)]));
  }

  upsertMedia(records: readonly MediaRecord[], seenAt: string): void {
    const statement = this.#db.prepare(UPSERT_MEDIA);
    this.#transaction(() => {
      for (const record of records) {
        statement.run(
          record.relPath,
          record.sha256,
          record.kind,
          record.sizeBytes,
          record.mtimeMs,
          record.promptJson,
          seenAt,
          seenAt,
        );
      }
    });
  }

  /**
   * Flags paths absent from the latest scan as missing and restores unchanged files
   * that reappeared. Rows whose state is already correct are left untouched.
   */
  markPresence(presentPaths: readonly string[], seenAt: string): void {
    const paths = JSON.stringify(presentPaths);
    this.#transaction(() => {
      this.#db
        .prepare(
          "UPDATE media SET missing = 1 WHERE missing = 0 AND rel_path NOT IN (SELECT value FROM json_each(?))",
        )
        .run(paths);
      this.#db
        .prepare(
          "UPDATE media SET missing = 0, last_seen_at = ? WHERE missing = 1 AND rel_path IN (SELECT value FROM json_each(?))",
        )
        .run(seenAt, paths);
    });
  }

  queue(mode: QueueMode): QueueItem[] {
    const rows = this.#db.prepare(QUEUE).all(mode, mode, mode) as unknown as QueueRow[];
    return rows.map((row) => ({
      sha256: row.sha256,
      relPath: row.rel_path,
      kind: row.kind,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      rating: row.rating,
      ratedAt: row.updated_at,
    }));
  }

  stats(): RatingStats {
    const row = this.#db.prepare(STATS).get() as unknown as RatingStats;
    return {
      total: row.total,
      unrated: row.unrated,
      reject: row.reject,
      keep: row.keep,
      hold: row.hold,
    };
  }

  findPresentFile(sha256: string): PresentFile | null {
    const row = this.#db
      .prepare(
        "SELECT rel_path, kind FROM media WHERE sha256 = ? AND missing = 0 ORDER BY rel_path LIMIT 1",
      )
      .get(sha256) as { rel_path: string; kind: MediaKind } | undefined;
    return row ? { relPath: row.rel_path, kind: row.kind } : null;
  }

  /** Returns false when the hash has never been seen in the media folder. */
  setRating(sha256: string, rating: Rating, ratedBy: string | null, at: string): boolean {
    const file = this.#db
      .prepare("SELECT rel_path FROM media WHERE sha256 = ? ORDER BY missing, rel_path LIMIT 1")
      .get(sha256) as { rel_path: string } | undefined;
    if (!file) return false;

    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO ratings (sha256, rating, rel_path, rated_at, updated_at, rated_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (sha256) DO UPDATE SET
             rating = excluded.rating,
             rel_path = excluded.rel_path,
             updated_at = excluded.updated_at,
             rated_by = excluded.rated_by`,
        )
        .run(sha256, rating, file.rel_path, at, at, ratedBy);
      this.#insertEvent(sha256, file.rel_path, rating, at, ratedBy);
    });
    return true;
  }

  /** Returns false when there was no rating to clear. */
  clearRating(sha256: string, ratedBy: string | null, at: string): boolean {
    const current = this.#db
      .prepare("SELECT rel_path FROM ratings WHERE sha256 = ?")
      .get(sha256) as { rel_path: string } | undefined;
    if (!current) return false;

    this.#transaction(() => {
      this.#db.prepare("DELETE FROM ratings WHERE sha256 = ?").run(sha256);
      this.#insertEvent(sha256, current.rel_path, null, at, ratedBy);
    });
    return true;
  }

  events(sha256: string): RatingEvent[] {
    const rows = this.#db
      .prepare(
        "SELECT rel_path, rating, created_at, rated_by FROM rating_events WHERE sha256 = ? ORDER BY id",
      )
      .all(sha256) as unknown as Array<{
      rel_path: string;
      rating: Rating | null;
      created_at: string;
      rated_by: string | null;
    }>;
    return rows.map((row) => ({
      relPath: row.rel_path,
      rating: row.rating,
      createdAt: row.created_at,
      ratedBy: row.rated_by,
    }));
  }

  /** One row per known file path, including files that have since disappeared. */
  exportRows(): ExportRow[] {
    const rows = this.#db
      .prepare(
        `SELECT m.rel_path, m.sha256, m.kind, m.size_bytes, m.mtime_ms, m.prompt_json, m.missing,
                r.rating, r.rated_at, r.updated_at, r.rated_by
         FROM media m
         LEFT JOIN ratings r ON r.sha256 = m.sha256
         ORDER BY m.mtime_ms, m.rel_path`,
      )
      .all() as unknown as ExportDbRow[];
    return rows.map((row) => ({
      ...toMediaRecord(row),
      missing: row.missing === 1,
      rating: row.rating,
      ratedAt: row.rated_at,
      updatedAt: row.updated_at,
      ratedBy: row.rated_by,
    }));
  }

  #insertEvent(
    sha256: string,
    relPath: string,
    rating: Rating | null,
    at: string,
    ratedBy: string | null,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO rating_events (sha256, rel_path, rating, created_at, rated_by) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sha256, relPath, rating, at, ratedBy);
  }

  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
