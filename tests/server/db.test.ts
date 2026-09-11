// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatingStore, type MediaRecord } from "../../server/db.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const AT = "2026-09-11T00:00:00.000Z";

function record(
  relPath: string,
  sha256: string,
  overrides: Partial<MediaRecord> = {},
): MediaRecord {
  return {
    relPath,
    sha256,
    kind: "image",
    sizeBytes: 100,
    mtimeMs: 1_000,
    promptJson: null,
    ...overrides,
  };
}

describe("RatingStore", () => {
  let store: RatingStore;

  beforeEach(() => {
    store = RatingStore.open(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function scan(records: MediaRecord[]) {
    store.upsertMedia(records, AT);
    store.markMissingExcept(records.map((item) => item.relPath));
  }

  it("queues one entry per content hash, oldest first", () => {
    scan([
      record("later/copy.png", A, { mtimeMs: 3_000 }),
      record("later/a.png", A, { mtimeMs: 2_000 }),
      record("first.png", B, { mtimeMs: 1_000 }),
    ]);

    expect(store.queue("unrated").map((item) => item.relPath)).toEqual([
      "first.png",
      "later/a.png",
    ]);
    expect(store.stats()).toEqual({ total: 2, unrated: 2, reject: 0, keep: 0, hold: 0 });
  });

  it("records ratings, their history and undo", () => {
    scan([record("a.png", A), record("b.png", B, { mtimeMs: 2_000 })]);

    expect(store.setRating(A, "hold", "ryu@example.com", AT)).toBe(true);
    expect(store.queue("unrated").map((item) => item.relPath)).toEqual(["b.png"]);
    expect(store.queue("hold")).toMatchObject([{ relPath: "a.png", rating: "hold", ratedAt: AT }]);

    expect(store.setRating(A, "keep", null, "2026-09-11T00:01:00.000Z")).toBe(true);
    expect(store.stats()).toEqual({ total: 2, unrated: 1, reject: 0, keep: 1, hold: 0 });

    expect(store.clearRating(A, null, "2026-09-11T00:02:00.000Z")).toBe(true);
    expect(store.clearRating(A, null, AT)).toBe(false);
    expect(store.events(A).map((event) => [event.rating, event.ratedBy])).toEqual([
      ["hold", "ryu@example.com"],
      ["keep", null],
      [null, null],
    ]);
    expect(store.setRating("c".repeat(64), "keep", null, AT)).toBe(false);
  });

  it("keeps a rating when the file moves and marks vanished paths missing", () => {
    scan([record("old/a.png", A)]);
    store.setRating(A, "reject", null, AT);

    scan([record("new/a.png", A)]);
    expect(store.queue("all")).toMatchObject([{ relPath: "new/a.png", rating: "reject" }]);
    expect(store.findPresentFile(A)).toEqual({ relPath: "new/a.png", kind: "image" });
    expect(store.exportRows().map((row) => [row.relPath, row.missing, row.rating])).toEqual([
      ["new/a.png", false, "reject"],
      ["old/a.png", true, "reject"],
    ]);

    scan([]);
    expect(store.findPresentFile(A)).toBeNull();
    expect(store.stats().total).toBe(0);
  });
});
