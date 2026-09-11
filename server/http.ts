import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getContentType, isQueueMode, isRating, isSha256 } from "../lib/media.ts";
import type { RatingStore } from "./db.ts";
import { buildRatingsCsv, buildRatingsJsonl, exportFilename } from "./export.ts";
import { errorMessage, type MediaLibrary } from "./library.ts";

const MAX_JSON_BODY_BYTES = 4 * 1024;
const QUEUE_SYNC_WAIT_MS = 2_000;
const MAX_RATED_BY_LENGTH = 200;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface AppOptions {
  store: RatingStore;
  library: MediaLibrary;
  mediaRoot: string;
  distDir: string | null;
  queueSyncMaxAgeMs?: number;
  /** Host names this server answers to; anything else is refused. */
  allowedHosts?: readonly string[];
  log?: (message: string) => void;
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Guards against DNS rebinding: a hostile page whose domain resolves to 127.0.0.1
 * still sends its own name in Host, so it cannot read or change ratings.
 */
function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (!hostHeader) return false;
  try {
    return allowedHosts.includes(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface ByteRange {
  start: number;
  end: number;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Parses a single `bytes=` range. Malformed or multi-range headers return null so
 * the whole file is sent, as RFC 9110 allows.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return null;
  const [, startText, endText] = match;

  if (startText === "") {
    if (endText === "") return null;
    const suffixLength = Number(endText);
    if (suffixLength === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText === "" ? Number.POSITIVE_INFINITY : Number(endText);
  if (requestedEnd < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function allowMethods(
  req: IncomingMessage,
  res: ServerResponse,
  methods: readonly string[],
): string {
  const method = req.method ?? "GET";
  if (!methods.includes(method)) {
    res.setHeader("Allow", methods.join(", "));
    throw new HttpError(405, "このメソッドは使えません");
  }
  return method;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, "リクエストが大きすぎます");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "JSON を解釈できません");
  }
}

function ratedBy(req: IncomingMessage): string | null {
  // Tailscale Serve adds this header for requests from tailnet users.
  const value = req.headers["tailscale-user-login"];
  return typeof value === "string" && value !== "" ? value.slice(0, MAX_RATED_BY_LENGTH) : null;
}

async function waitAtMost(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRequestHandler(options: AppOptions) {
  const { store, library } = options;
  const log = options.log ?? ((message: string) => console.error(message));
  const queueSyncMaxAgeMs = options.queueSyncMaxAgeMs ?? 5_000;
  const distDir = options.distDir ? path.resolve(options.distDir) : null;

  async function putRating(req: IncomingMessage, res: ServerResponse, sha256: string) {
    const contentType = req.headers["content-type"] ?? "";
    // Requiring JSON forces a CORS preflight, so other sites cannot post ratings.
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "JSON で送信してください");
    }
    const body = await readJsonBody(req);
    const rating =
      typeof body === "object" && body !== null ? (body as { rating?: unknown }).rating : undefined;
    if (!isRating(rating)) {
      throw new HttpError(400, "rating は reject / keep / hold のいずれかです");
    }
    if (!store.setRating(sha256, rating, ratedBy(req), new Date().toISOString())) {
      throw new HttpError(404, "この画像・動画は登録されていません");
    }
    sendJson(res, 200, { sha256, rating });
  }

  function deleteRating(req: IncomingMessage, res: ServerResponse, sha256: string) {
    if (!store.clearRating(sha256, ratedBy(req), new Date().toISOString())) {
      throw new HttpError(404, "評価がありません");
    }
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
  }

  function sendExport(res: ServerResponse, format: "csv" | "jsonl") {
    const rows = store.exportRows();
    const body = format === "csv" ? buildRatingsCsv(rows) : buildRatingsJsonl(rows);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type":
        format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(format)}"`,
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function serveMedia(
    req: IncomingMessage,
    res: ServerResponse,
    sha256: string,
    headOnly: boolean,
  ) {
    const file = isSha256(sha256) ? store.findPresentFile(sha256) : null;
    if (!file) throw new HttpError(404, "見つかりません");
    const rootReal = await realpath(options.mediaRoot).catch(() => null);
    if (!rootReal) throw new HttpError(404, "メディアフォルダが見つかりません");

    let resolved: string;
    try {
      resolved = await realpath(path.join(rootReal, file.relPath));
    } catch {
      void library.sync();
      throw new HttpError(404, "ファイルが見つかりません");
    }
    // Scans skip symlinks, but a file could be swapped for one afterwards.
    if (!isInside(rootReal, resolved)) throw new HttpError(404, "見つかりません");
    const stats = await stat(resolved);
    if (!stats.isFile()) throw new HttpError(404, "見つかりません");

    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": getContentType(file.relPath) ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
      "Last-Modified": stats.mtime.toUTCString(),
    };
    const range = parseRange(req.headers.range, stats.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
      res.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? stats.size - 1;
    const length = Math.max(end - start + 1, 0);
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "Content-Length": length,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${stats.size}` } : {}),
    });
    if (headOnly || length === 0) {
      res.end();
      return;
    }
    await pipeline(createReadStream(resolved, { start, end }), res);
  }

  async function serveStatic(res: ServerResponse, pathname: string, headOnly: boolean) {
    if (!distDir) throw new HttpError(404, "見つかりません");
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "URL が不正です");
    }

    const indexPath = path.join(distDir, "index.html");
    let filePath = indexPath;
    const candidate = path.join(distDir, decoded);
    if (decoded !== "/" && isInside(distDir, candidate)) {
      const candidateStats = await stat(candidate).catch(() => null);
      if (candidateStats?.isFile()) filePath = candidate;
      // Unknown asset URLs 404; anything else falls back to the single-page app.
      else if (path.extname(decoded)) throw new HttpError(404, "見つかりません");
    }

    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) {
      throw new HttpError(503, "画面ファイルがありません。npm run build を実行してください");
    }
    const immutable = filePath !== indexPath && decoded.startsWith("/assets/");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": STATIC_CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "Content-Length": fileStats.size,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (headOnly) {
      res.end();
      return;
    }
    await pipeline(createReadStream(filePath), res);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (pathname === "/api/queue") {
      allowMethods(req, res, ["GET"]);
      const mode = url.searchParams.get("mode") ?? "unrated";
      if (!isQueueMode(mode)) throw new HttpError(400, "mode が不正です");
      // Pick up new arrivals, but never keep the viewer waiting on a long first import.
      await waitAtMost(library.syncIfStale(queueSyncMaxAgeMs), QUEUE_SYNC_WAIT_MS);
      sendJson(res, 200, {
        mode,
        items: store.queue(mode),
        stats: store.stats(),
        scanError: library.lastError,
      });
      return;
    }

    if (pathname === "/api/stats") {
      allowMethods(req, res, ["GET"]);
      sendJson(res, 200, { stats: store.stats(), scanError: library.lastError });
      return;
    }

    const ratingMatch = /^\/api\/ratings\/([^/]+)$/.exec(pathname);
    if (ratingMatch) {
      const method = allowMethods(req, res, ["PUT", "DELETE"]);
      const sha256 = ratingMatch[1];
      if (!isSha256(sha256)) throw new HttpError(400, "sha256 が不正です");
      if (method === "PUT") await putRating(req, res, sha256);
      else deleteRating(req, res, sha256);
      return;
    }

    if (pathname === "/api/export.csv" || pathname === "/api/export.jsonl") {
      allowMethods(req, res, ["GET"]);
      sendExport(res, pathname.endsWith(".csv") ? "csv" : "jsonl");
      return;
    }

    const mediaMatch = /^\/media\/([^/]+)$/.exec(pathname);
    if (mediaMatch) {
      const method = allowMethods(req, res, ["GET", "HEAD"]);
      await serveMedia(req, res, mediaMatch[1], method === "HEAD");
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/media/")) {
      throw new HttpError(404, "見つかりません");
    }
    const method = allowMethods(req, res, ["GET", "HEAD"]);
    await serveStatic(res, pathname, method === "HEAD");
  }

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host, options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)) {
      sendJson(res, 421, { error: "このホスト名ではアクセスできません" });
      return;
    }
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        // Usually the browser dropped a media stream while seeking.
        if ((error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
          log(`応答中にエラーが発生しました: ${req.method} ${req.url}: ${errorMessage(error)}`);
        }
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      log(`リクエストを処理できませんでした: ${req.method} ${req.url}: ${errorMessage(error)}`);
      sendJson(res, 500, { error: "サーバーでエラーが発生しました" });
    }
  };
}
