export type Rating = "reject" | "keep" | "hold";

export type MediaKind = "image" | "video";

export type QueueMode = "unrated" | "hold" | "all";

export const RATINGS: readonly Rating[] = ["reject", "keep", "hold"];

export const QUEUE_MODES: readonly QueueMode[] = ["unrated", "hold", "all"];

export interface QueueItem {
  sha256: string;
  relPath: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  rating: Rating | null;
  ratedAt: string | null;
}

export interface RatingStats {
  total: number;
  unrated: number;
  reject: number;
  keep: number;
  hold: number;
}

const MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; contentType: string }>> = {
  jpg: { kind: "image", contentType: "image/jpeg" },
  jpeg: { kind: "image", contentType: "image/jpeg" },
  png: { kind: "image", contentType: "image/png" },
  webp: { kind: "image", contentType: "image/webp" },
  gif: { kind: "image", contentType: "image/gif" },
  avif: { kind: "image", contentType: "image/avif" },
  mp4: { kind: "video", contentType: "video/mp4" },
  webm: { kind: "video", contentType: "video/webm" },
  m4v: { kind: "video", contentType: "video/x-m4v" },
  ogv: { kind: "video", contentType: "video/ogg" },
};

export const MEDIA_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES);

export function getExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  return name.slice(dotIndex + 1).toLocaleLowerCase("en-US");
}

function lookupMediaType(name: string) {
  const extension = getExtension(name);
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : null;
}

export function getMediaKind(name: string): MediaKind | null {
  return lookupMediaType(name)?.kind ?? null;
}

export function getContentType(name: string): string | null {
  return lookupMediaType(name)?.contentType ?? null;
}

export function isRating(value: unknown): value is Rating {
  return typeof value === "string" && (RATINGS as readonly string[]).includes(value);
}

export function isQueueMode(value: unknown): value is QueueMode {
  return typeof value === "string" && (QUEUE_MODES as readonly string[]).includes(value);
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
