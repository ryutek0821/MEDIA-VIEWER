import type { ExportRow } from "./db.ts";

const CSV_COLUMNS = [
  "sha256",
  "rel_path",
  "kind",
  "rating",
  "rated_at",
  "updated_at",
  "rated_by",
  "size_bytes",
  "mtime",
  "missing",
  "prompt_json",
];

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  // Stop spreadsheet apps from evaluating file names or prompts as formulas.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function parsePrompt(promptJson: string | null): unknown {
  if (promptJson === null) return null;
  try {
    return JSON.parse(promptJson) as unknown;
  } catch {
    return promptJson;
  }
}

export function buildRatingsCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const cells = [
      row.sha256,
      row.relPath,
      row.kind,
      row.rating,
      row.ratedAt,
      row.updatedAt,
      row.ratedBy,
      row.sizeBytes,
      isoTime(row.mtimeMs),
      row.missing ? 1 : 0,
      row.promptJson,
    ];
    lines.push(cells.map((cell) => csvCell(cell)).join(","));
  }
  // The BOM lets Excel read the UTF-8 file names correctly.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function buildRatingsJsonl(rows: readonly ExportRow[]): string {
  return rows
    .map(
      (row) =>
        `${JSON.stringify({
          sha256: row.sha256,
          relPath: row.relPath,
          kind: row.kind,
          rating: row.rating,
          ratedAt: row.ratedAt,
          updatedAt: row.updatedAt,
          ratedBy: row.ratedBy,
          sizeBytes: row.sizeBytes,
          mtime: isoTime(row.mtimeMs),
          missing: row.missing,
          prompt: parsePrompt(row.promptJson),
        })}\n`,
    )
    .join("");
}

export function exportFilename(extension: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `media-ratings-${date}-${time}.${extension}`;
}
