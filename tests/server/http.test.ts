// @vitest-environment node

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueueItem, RatingStats } from "../../lib/media.ts";
import { RatingStore } from "../../server/db.ts";
import { createRequestHandler, parseRange } from "../../server/http.ts";
import { MediaLibrary } from "../../server/library.ts";
import { makePng, makeTempDir, textChunk } from "./helpers.ts";

const PROMPT = '{"3":{"class_type":"KSampler"}}';

describe("parseRange", () => {
  it("parses single byte ranges and ignores unsupported forms", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
  });
});

describe("HTTP API", () => {
  const tempDirs: string[] = [];
  let root: string;
  let store: RatingStore;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    root = await makeTempDir("media-root-");
    const dist = await makeTempDir("media-dist-");
    tempDirs.push(root, dist);
    await mkdir(path.join(root, "batch"));
    await writeFile(path.join(root, "batch", "a.png"), makePng([textChunk("prompt", PROMPT)]));
    await writeFile(path.join(root, "b.mp4"), "0123456789");
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>MARIN</title>");
    await writeFile(path.join(dist, "assets", "app.js"), "console.log(1)");

    store = RatingStore.open(":memory:");
    const library = new MediaLibrary({ mediaRoot: root, store, settleMs: 0, log: () => {} });
    await library.sync();
    server = createServer(
      createRequestHandler({ store, library, mediaRoot: root, distDir: dist, log: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function getQueue(mode = "unrated") {
    const response = await fetch(`${base}/api/queue?mode=${mode}`);
    expect(response.status).toBe(200);
    return (await response.json()) as { items: QueueItem[]; stats: RatingStats };
  }

  async function shaOf(relPath: string) {
    const item = (await getQueue("all")).items.find((entry) => entry.relPath === relPath);
    if (!item) throw new Error(`${relPath} is not in the queue`);
    return item.sha256;
  }

  function sendRating(
    sha256: string,
    body: unknown,
    headers: Record<string, string> = { "Content-Type": "application/json" },
  ) {
    return fetch(`${base}/api/ratings/${sha256}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("lists unrated media with counts", async () => {
    const { items, stats } = await getQueue();
    expect(items.map((item) => [item.relPath, item.kind]).sort()).toEqual([
      ["b.mp4", "video"],
      ["batch/a.png", "image"],
    ]);
    expect(stats).toEqual({ total: 2, unrated: 2, reject: 0, keep: 0, hold: 0 });
  });

  it("records ratings with the tailnet user and supports undo", async () => {
    const sha = await shaOf("batch/a.png");
    const response = await sendRating(
      sha,
      { rating: "hold" },
      { "Content-Type": "application/json", "Tailscale-User-Login": "ryu@example.com" },
    );
    expect(response.status).toBe(200);
    expect((await getQueue()).items.map((item) => item.relPath)).toEqual(["b.mp4"]);
    expect((await getQueue("hold")).items).toMatchObject([
      { relPath: "batch/a.png", rating: "hold" },
    ]);

    const jsonl = await (await fetch(`${base}/api/export.jsonl`)).text();
    const rows = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.find((row) => row.relPath === "batch/a.png")).toMatchObject({
      sha256: sha,
      rating: "hold",
      ratedBy: "ryu@example.com",
      prompt: { "3": { class_type: "KSampler" } },
    });

    expect((await fetch(`${base}/api/ratings/${sha}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/api/ratings/${sha}`, { method: "DELETE" })).status).toBe(404);
    expect((await getQueue()).stats.unrated).toBe(2);
  });

  it("rejects invalid rating requests", async () => {
    const sha = await shaOf("b.mp4");
    expect((await sendRating(sha, { rating: "keep" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await sendRating(sha, { rating: "maybe" })).status).toBe(400);
    expect((await sendRating("f".repeat(64), { rating: "keep" })).status).toBe(404);
    expect((await sendRating("not-a-hash", { rating: "keep" })).status).toBe(400);
    expect((await fetch(`${base}/api/queue?mode=bogus`)).status).toBe(400);
    expect((await fetch(`${base}/api/queue`, { method: "POST" })).status).toBe(405);
  });

  it("streams media with byte ranges", async () => {
    const url = `${base}/media/${await shaOf("b.mp4")}`;

    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");

    const partial = await fetch(url, { headers: { Range: "bytes=2-5" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const beyond = await fetch(url, { headers: { Range: "bytes=20-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10");

    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");

    expect((await fetch(`${base}/media/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("refuses to follow a symlink that leaves the media folder", async () => {
    const sha = await shaOf("batch/a.png");
    const outside = await makeTempDir("media-outside-");
    tempDirs.push(outside);
    await writeFile(path.join(outside, "secret.png"), "secret");
    await rm(path.join(root, "batch", "a.png"));
    await symlink(path.join(outside, "secret.png"), path.join(root, "batch", "a.png"));

    const response = await fetch(`${base}/media/${sha}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });

  it("exports ratings as CSV", async () => {
    await sendRating(await shaOf("batch/a.png"), { rating: "keep" });

    const response = await fetch(`${base}/api/export.csv`);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="media-ratings-\d{8}-\d{6}\.csv"$/,
    );
    const [header, ...lines] = (await response.text()).trim().split("\r\n");
    expect(header).toBe(
      "sha256,rel_path,kind,rating,rated_at,updated_at,rated_by,size_bytes,mtime,missing,prompt_json",
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.includes("batch/a.png"))).toContain(",image,keep,");
  });

  it("serves the built app with a single-page fallback", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await index.text()).toContain("<title>MARIN</title>");

    expect(await (await fetch(`${base}/review`)).text()).toContain("<title>MARIN</title>");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });

  it("refuses requests addressed to another host name (DNS rebinding)", async () => {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/export.csv",
          headers: { Host: `attacker.example:${port}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(421);
  });
});
