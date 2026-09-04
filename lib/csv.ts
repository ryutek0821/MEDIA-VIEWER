import type { Decision, MediaItem, MediaKind } from "./media";
import type { ReviewDecision } from "./session-store";

export interface CsvDecisionRow {
  reviewOrder: number;
  relativePath: string;
  fileName: string;
  mediaType: MediaKind;
  decision: Decision;
  sizeBytes: number;
  lastModified: number | string | Date;
  decidedAt: number | string | Date;
}

export interface CsvSaveResult {
  filename: string;
  destination: "folder" | "download";
}

export type DecisionLookup = Readonly<
  Record<string, ReviewDecision | undefined>
>;

const CSV_HEADER = [
  "review_order",
  "relative_path",
  "file_name",
  "media_type",
  "decision",
  "size_bytes",
  "last_modified_iso",
  "decided_at_iso",
] as const;

function csvCell(value: string | number): string {
  const text = String(value);
  const safeText =
    typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (!/[",\r\n]/.test(safeText)) return safeText;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function isoDate(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid CSV date: ${String(value)}`);
  }
  return date.toISOString();
}

export function createCsvDecisionRows(
  items: readonly MediaItem[],
  decisions: DecisionLookup,
): CsvDecisionRow[] {
  return items.map((item, index) => {
    const stored = decisions[item.relativePath] ?? decisions[item.id];
    if (!stored) {
      throw new Error(`Missing decision for ${item.relativePath}`);
    }
    return {
      reviewOrder: index + 1,
      relativePath: item.relativePath,
      fileName: item.name,
      mediaType: item.kind,
      decision: stored.decision,
      sizeBytes: item.sizeBytes,
      lastModified: item.lastModified,
      decidedAt: stored.decidedAt,
    };
  });
}

export function buildDecisionsCsv(rows: readonly CsvDecisionRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.reviewOrder,
        row.relativePath,
        row.fileName,
        row.mediaType,
        row.decision,
        row.sizeBytes,
        isoDate(row.lastModified),
        isoDate(row.decidedAt),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createCsvFilename(now = new Date(), suffix = 1): string {
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const duplicateSuffix = suffix > 1 ? `-${suffix}` : "";
  return `media-decisions-${timestamp}${duplicateSuffix}.csv`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "NotFoundError"
    : Boolean(
        error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "NotFoundError",
      );
}

async function availableFilename(
  rootHandle: FileSystemDirectoryHandle,
  now: Date,
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = createCsvFilename(now, suffix);
    try {
      await rootHandle.getFileHandle(candidate);
    } catch (error) {
      if (isNotFound(error)) return candidate;
      throw error;
    }
  }
}

export function downloadCsv(csv: string, filename: string): boolean {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return false;
  }

  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export async function getWritableDirectoryHandle(
  rootHandle: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle | null> {
  const permission = { mode: "readwrite" } as const;

  try {
    if (typeof rootHandle.queryPermission !== "function") return null;
    if ((await rootHandle.queryPermission(permission)) === "granted") {
      return rootHandle;
    }
    if (typeof rootHandle.requestPermission !== "function") return null;
    return (await rootHandle.requestPermission(permission)) === "granted"
      ? rootHandle
      : null;
  } catch {
    return null;
  }
}

export async function saveDecisionsCsv(
  rootHandle: FileSystemDirectoryHandle | null,
  rows: readonly CsvDecisionRow[],
  now = new Date(),
): Promise<CsvSaveResult> {
  const csv = buildDecisionsCsv(rows);
  let filename = createCsvFilename(now);

  if (rootHandle) {
    try {
      filename = await availableFilename(rootHandle, now);
      const fileHandle = await rootHandle.getFileHandle(filename, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(csv);
      await writable.close();
      return { filename, destination: "folder" };
    } catch {
      // The explicit browser download below is the recovery path for lost
      // permissions and browsers without writable directory handles.
    }
  }

  if (!downloadCsv(csv, filename)) {
    throw new Error("CSV could not be saved or downloaded in this browser.");
  }
  return { filename, destination: "download" };
}
