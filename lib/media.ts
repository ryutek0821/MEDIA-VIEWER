export type Decision = "keep" | "reject";

export type MediaKind = "image" | "video";

export type SortMode = "name" | "oldest" | "newest" | "random";

export interface MediaItem {
  id: string;
  relativePath: string;
  name: string;
  kind: MediaKind;
  sizeBytes: number;
  lastModified: number;
  handle: FileSystemFileHandle;
}

export interface ScanError {
  path: string;
  operation: "read-directory" | "read-file";
  message: string;
}

export interface IgnoredMedia {
  hiddenFiles: number;
  hiddenDirectories: number;
  skippedDirectories: number;
  skippedNestedFiles: number;
  unsupportedFiles: number;
  unsupportedExtensions: Record<string, number>;
}

export interface ScanMediaResult {
  items: MediaItem[];
  ignoredCount: number;
  ignoredExtensions: Record<string, number>;
  ignored: IgnoredMedia;
  errors: ScanError[];
}

export interface ScanMediaOptions {
  recursive?: boolean;
}

export const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
] as const;

export const VIDEO_EXTENSIONS = ["mp4", "webm", "m4v", "ogv"] as const;

const IMAGE_EXTENSION_SET = new Set<string>(IMAGE_EXTENSIONS);
const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS);
const NO_EXTENSION = "(拡張子なし)";
const naturalJapaneseCollator = new Intl.Collator("ja", {
  numeric: true,
  sensitivity: "base",
});

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<
    [string, FileSystemFileHandle | FileSystemDirectoryHandle]
  >;
};

function getExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex + 1).toLocaleLowerCase("en-US");
}

export function getMediaKind(name: string): MediaKind | null {
  const extension = getExtension(name);
  if (IMAGE_EXTENSION_SET.has(extension)) return "image";
  if (VIDEO_EXTENSION_SET.has(extension)) return "video";
  return null;
}

function compareText(left: string, right: string): number {
  const naturalResult = naturalJapaneseCollator.compare(left, right);
  if (naturalResult !== 0) return naturalResult;

  // Collator sensitivity is deliberately forgiving, so add a stable final tie-break.
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareByPath(left: MediaItem, right: MediaItem): number {
  return (
    compareText(left.relativePath, right.relativePath) ||
    compareText(left.id, right.id)
  );
}

function compareByName(left: MediaItem, right: MediaItem): number {
  return compareText(left.name, right.name) || compareByPath(left, right);
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

/**
 * Enumerates media without uploading or retaining file contents. Each supported
 * file is opened only long enough to read its size and modification timestamp.
 */
export async function scanMediaDirectory(
  rootHandle: FileSystemDirectoryHandle,
  options: ScanMediaOptions = {},
): Promise<ScanMediaResult> {
  const recursive = options.recursive ?? false;
  const result: ScanMediaResult = {
    items: [],
    ignoredCount: 0,
    ignoredExtensions: {},
    ignored: {
      hiddenFiles: 0,
      hiddenDirectories: 0,
      skippedDirectories: 0,
      skippedNestedFiles: 0,
      unsupportedFiles: 0,
      unsupportedExtensions: {},
    },
    errors: [],
  };

  async function visitDirectory(
    directory: FileSystemDirectoryHandle,
    parentPath: string,
  ): Promise<void> {
    try {
      const iterable = (directory as DirectoryHandleWithEntries).entries();

      for await (const [entryName, entryHandle] of iterable) {
        const relativePath = parentPath
          ? `${parentPath}/${entryName}`
          : entryName;

        if (entryName.startsWith(".")) {
          if (entryHandle.kind === "directory") {
            result.ignored.hiddenDirectories += 1;
          } else {
            result.ignored.hiddenFiles += 1;
          }
          continue;
        }

        if (entryHandle.kind === "directory") {
          if (recursive) {
            await visitDirectory(entryHandle, relativePath);
          } else {
            result.ignored.skippedDirectories += 1;
          }
          continue;
        }

        const kind = getMediaKind(entryName);
        if (!kind) {
          const extension = getExtension(entryName) || NO_EXTENSION;
          result.ignored.unsupportedFiles += 1;
          result.ignored.unsupportedExtensions[extension] =
            (result.ignored.unsupportedExtensions[extension] ?? 0) + 1;
          continue;
        }

        try {
          const file = await entryHandle.getFile();
          result.items.push({
            id: relativePath,
            relativePath,
            name: entryName,
            kind,
            sizeBytes: file.size,
            lastModified: file.lastModified,
            handle: entryHandle,
          });
        } catch (error) {
          result.errors.push({
            path: relativePath,
            operation: "read-file",
            message: errorMessage(error),
          });
        }
      }
    } catch (error) {
      result.errors.push({
        path: parentPath || rootHandle.name,
        operation: "read-directory",
        message: errorMessage(error),
      });
    }
  }

  await visitDirectory(rootHandle, "");

  // A conforming DirectoryHandle only yields direct children, but keep the
  // root-only contract intact even if a browser adapter returns relative paths.
  if (!recursive) {
    const rootItems = result.items.filter(
      (item) => !item.relativePath.includes("/"),
    );
    result.ignored.skippedNestedFiles += result.items.length - rootItems.length;
    result.items = rootItems;
  }

  result.items.sort(compareByPath);
  result.ignored.unsupportedExtensions = Object.fromEntries(
    Object.entries(result.ignored.unsupportedExtensions).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  result.ignoredCount =
    result.ignored.hiddenFiles +
    result.ignored.hiddenDirectories +
    result.ignored.skippedDirectories +
    result.ignored.skippedNestedFiles +
    result.ignored.unsupportedFiles;
  result.ignoredExtensions = { ...result.ignored.unsupportedExtensions };

  return result;
}

function hashSeed(seed: string | number): number {
  const input = String(seed);
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Returns a new array and never mutates the scanned manifest. */
export function sortMediaItems(
  items: readonly MediaItem[],
  mode: SortMode,
  randomSeed: string | number = "media-viewer",
): MediaItem[] {
  const sorted = [...items];

  if (mode === "name") return sorted.sort(compareByName);

  if (mode === "oldest" || mode === "newest") {
    const direction = mode === "oldest" ? 1 : -1;
    return sorted.sort(
      (left, right) =>
        (left.lastModified - right.lastModified) * direction ||
        compareByName(left, right),
    );
  }

  // Canonicalizing first makes the same persisted seed independent of scan order.
  sorted.sort(compareByPath);
  const random = seededRandom(hashSeed(randomSeed));
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [sorted[index], sorted[swapIndex]] = [sorted[swapIndex], sorted[index]];
  }
  return sorted;
}

/**
 * Fingerprints only the selected scope and file manifest; file contents and
 * handles never leave the browser or enter the digest.
 */
export async function createManifestFingerprint(
  rootName: string,
  recursive: boolean,
  items: readonly MediaItem[],
): Promise<string> {
  const manifest = {
    version: 1,
    rootName,
    scope: recursive ? "recursive" : "root-only",
    files: [...items].sort(compareByPath).map((item) => [
      item.relativePath,
      item.sizeBytes,
      item.lastModified,
    ]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `v1:${hex}`;
}
