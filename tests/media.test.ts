import { describe, expect, it } from "vitest";
import {
  createManifestFingerprint,
  getMediaKind,
  scanMediaDirectory,
  sortMediaItems,
  type MediaItem,
} from "../lib/media";

type MockEntry = FileSystemFileHandle | FileSystemDirectoryHandle;

function fileHandle(
  name: string,
  size = 100,
  lastModified = 1_700_000_000_000,
  failure?: Error,
): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      if (failure) throw failure;
      return { name, size, lastModified } as File;
    },
  } as FileSystemFileHandle;
}

function directoryHandle(
  name: string,
  entries: Array<[string, MockEntry]>,
): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    async *entries() {
      yield* entries;
    },
  } as unknown as FileSystemDirectoryHandle;
}

function item(
  name: string,
  lastModified = 1_700_000_000_000,
  relativePath = name,
): MediaItem {
  return {
    id: relativePath,
    relativePath,
    name,
    kind: "image",
    sizeBytes: 100,
    lastModified,
    handle: fileHandle(name, 100, lastModified),
  };
}

describe("getMediaKind", () => {
  it("recognizes all supported formats case-insensitively", () => {
    for (const extension of ["jpg", "jpeg", "png", "webp", "gif", "avif"]) {
      expect(getMediaKind(`photo.${extension.toUpperCase()}`)).toBe("image");
    }
    for (const extension of ["mp4", "webm", "m4v", "ogv"]) {
      expect(getMediaKind(`clip.${extension.toUpperCase()}`)).toBe("video");
    }
    expect(getMediaKind("archive.mov")).toBeNull();
    expect(getMediaKind("no-extension")).toBeNull();
  });
});

describe("scanMediaDirectory", () => {
  const nested = directoryHandle("旅行", [
    ["写真10.JPG", fileHandle("写真10.JPG", 10, 10)],
    ["写真2.jpg", fileHandle("写真2.jpg", 20, 20)],
    [".cache.png", fileHandle(".cache.png")],
  ]);
  const hiddenDirectory = directoryHandle(".private", [
    ["secret.jpg", fileHandle("secret.jpg")],
  ]);
  const root = directoryHandle("album", [
    ["cover.PNG", fileHandle("cover.PNG", 30, 30)],
    ["notes.txt", fileHandle("notes.txt")],
    ["README", fileHandle("README")],
    [".DS_Store", fileHandle(".DS_Store")],
    ["旅行", nested],
    [".private", hiddenDirectory],
    ["broken.mp4", fileHandle("broken.mp4", 0, 0, new Error("gone"))],
  ]);

  it("scans only the root by default and reports ignored entries and errors", async () => {
    const result = await scanMediaDirectory(root);

    expect(result.items.map((media) => media.relativePath)).toEqual(["cover.PNG"]);
    expect(result.ignored).toEqual({
      hiddenFiles: 1,
      hiddenDirectories: 1,
      skippedDirectories: 1,
      skippedNestedFiles: 0,
      unsupportedFiles: 2,
      unsupportedExtensions: { "(拡張子なし)": 1, txt: 1 },
    });
    expect(result.ignoredCount).toBe(5);
    expect(result.ignoredExtensions).toEqual({ "(拡張子なし)": 1, txt: 1 });
    expect(result.errors).toEqual([
      { path: "broken.mp4", operation: "read-file", message: "gone" },
    ]);
  });

  it("recurses without entering hidden directories", async () => {
    const result = await scanMediaDirectory(root, { recursive: true });

    expect(result.items.map((media) => media.relativePath)).toEqual([
      "cover.PNG",
      "旅行/写真2.jpg",
      "旅行/写真10.JPG",
    ]);
    expect(result.ignored.hiddenDirectories).toBe(1);
    expect(result.ignored.hiddenFiles).toBe(2);
    expect(result.ignored.skippedDirectories).toBe(0);
  });

  it("keeps root-only scans root-only when an adapter yields a nested path", async () => {
    const nonStandardRoot = directoryHandle("root", [
      ["direct.jpg", fileHandle("direct.jpg")],
      ["child/nested.jpg", fileHandle("nested.jpg")],
    ]);

    const result = await scanMediaDirectory(nonStandardRoot, { recursive: false });

    expect(result.items.map((media) => media.relativePath)).toEqual(["direct.jpg"]);
    expect(result.ignored.skippedNestedFiles).toBe(1);
    expect(result.ignoredCount).toBe(1);
  });

  it("does not fail the full scan when a directory cannot be enumerated", async () => {
    const blocked = {
      kind: "directory",
      name: "blocked",
      entries() {
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    } as unknown as FileSystemDirectoryHandle;
    const localRoot = directoryHandle("root", [
      ["ok.jpg", fileHandle("ok.jpg")],
      ["blocked", blocked],
    ]);

    const result = await scanMediaDirectory(localRoot, { recursive: true });

    expect(result.items).toHaveLength(1);
    expect(result.errors).toEqual([
      {
        path: "blocked",
        operation: "read-directory",
        message: "Permission denied",
      },
    ]);
  });
});

describe("sortMediaItems", () => {
  it("sorts Japanese names naturally and numerically", () => {
    const items = [item("写真10.jpg"), item("写真1.jpg"), item("写真2.jpg")];

    expect(sortMediaItems(items, "name").map((media) => media.name)).toEqual([
      "写真1.jpg",
      "写真2.jpg",
      "写真10.jpg",
    ]);
    expect(items.map((media) => media.name)).toEqual([
      "写真10.jpg",
      "写真1.jpg",
      "写真2.jpg",
    ]);
  });

  it("uses natural name order to break timestamp ties", () => {
    const items = [item("b.jpg", 20), item("c.jpg", 10), item("a.jpg", 20)];

    expect(sortMediaItems(items, "oldest").map((media) => media.name)).toEqual([
      "c.jpg",
      "a.jpg",
      "b.jpg",
    ]);
    expect(sortMediaItems(items, "newest").map((media) => media.name)).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("reproduces a random order from the persisted seed and scan-independent input", () => {
    const items = Array.from({ length: 8 }, (_, index) => item(`${index}.jpg`));
    const first = sortMediaItems(items, "random", "session-seed").map(
      (media) => media.id,
    );
    const second = sortMediaItems([...items].reverse(), "random", "session-seed").map(
      (media) => media.id,
    );

    expect(second).toEqual(first);
    expect(new Set(first)).toEqual(new Set(items.map((media) => media.id)));
  });
});

describe("createManifestFingerprint", () => {
  it("is order-independent but includes root, scope, path, size, and mtime", async () => {
    const first = item("写真2.jpg", 2);
    const second = { ...item("写真10.jpg", 10), sizeBytes: 999 };

    const fingerprint = await createManifestFingerprint("album", false, [
      second,
      first,
    ]);
    await expect(
      createManifestFingerprint("album", false, [first, second]),
    ).resolves.toBe(fingerprint);
    await expect(
      createManifestFingerprint("album", true, [first, second]),
    ).resolves.not.toBe(fingerprint);
    await expect(
      createManifestFingerprint("other", false, [first, second]),
    ).resolves.not.toBe(fingerprint);
    await expect(
      createManifestFingerprint("album", false, [
        first,
        { ...second, sizeBytes: 1_000 },
      ]),
    ).resolves.not.toBe(fingerprint);
  });
});
