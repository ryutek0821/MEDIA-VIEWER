import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  deleteReviewSession,
  findMatchingSession,
  listReviewSessions,
  saveReviewSession,
  sessionMatches,
  type ReviewSessionV1,
} from "../lib/session-store";

function directoryHandle(
  name: string,
  sameEntry: (other: FileSystemHandle) => Promise<boolean>,
): FileSystemDirectoryHandle {
  return { name, kind: "directory", isSameEntry: sameEntry } as unknown as FileSystemDirectoryHandle;
}

function session(rootHandle: FileSystemDirectoryHandle): ReviewSessionV1 {
  return {
    schemaVersion: 1,
    id: "session-1",
    rootName: "写真",
    rootHandle,
    manifestFingerprint: "fingerprint",
    includeSubfolders: true,
    sortMode: "name",
    randomSeed: 123,
    orderedPaths: ["photo.jpg"],
    decisions: {},
    history: [],
    createdAt: "2026-09-04T01:00:00.000Z",
    updatedAt: "2026-09-04T01:00:00.000Z",
    completedAt: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("session matching", () => {
  it("requires the same directory, manifest, and scan scope", async () => {
    const selected = directoryHandle("写真", async () => false);
    const stored = directoryHandle("写真", async (other) => other === selected);
    const value = session(stored);

    await expect(
      sessionMatches(value, {
        rootHandle: selected,
        manifestFingerprint: "fingerprint",
        includeSubfolders: true,
      }),
    ).resolves.toBe(true);
    await expect(
      sessionMatches(value, {
        rootHandle: selected,
        manifestFingerprint: "changed",
        includeSubfolders: true,
      }),
    ).resolves.toBe(false);
    await expect(
      sessionMatches(value, {
        rootHandle: selected,
        manifestFingerprint: "fingerprint",
        includeSubfolders: false,
      }),
    ).resolves.toBe(false);
  });
});

describe("IndexedDB availability", () => {
  it("saves, lists, and deletes metadata without storing media blobs", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const root = {
      name: "写真",
      kind: "directory",
    } as FileSystemDirectoryHandle;
    const value = session(root);

    await expect(saveReviewSession(value)).resolves.toBe(true);
    await expect(listReviewSessions()).resolves.toEqual([
      expect.objectContaining({
        id: "session-1",
        orderedPaths: ["photo.jpg"],
        decisions: {},
      }),
    ]);
    await expect(deleteReviewSession("session-1")).resolves.toBe(true);
    await expect(listReviewSessions()).resolves.toEqual([]);
  });

  it("returns safe fallbacks when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const root = directoryHandle("写真", async () => true);

    await expect(saveReviewSession(session(root))).resolves.toBe(false);
    await expect(listReviewSessions()).resolves.toEqual([]);
    await expect(
      findMatchingSession({
        rootHandle: root,
        manifestFingerprint: "fingerprint",
        includeSubfolders: true,
      }),
    ).resolves.toBeNull();
  });
});
