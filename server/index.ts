import { createServer } from "node:http";
import { databasePath, loadConfig } from "./config.ts";
import { RatingStore } from "./db.ts";
import { createRequestHandler } from "./http.ts";
import { MediaLibrary } from "./library.ts";

const RESCAN_INTERVAL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

const config = loadConfig();
const store = RatingStore.open(databasePath(config));
const library = new MediaLibrary({ mediaRoot: config.mediaRoot, store, log });
const server = createServer(
  createRequestHandler({
    store,
    library,
    mediaRoot: config.mediaRoot,
    distDir: config.distDir,
    log,
  }),
);

server.on("error", (error) => {
  log(`サーバーを起動できませんでした: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(
    `[${new Date().toISOString()}] Media Viewer: http://${config.host}:${config.port}/ ` +
      `(MEDIA_ROOT=${config.mediaRoot}, DB=${databasePath(config)})`,
  );
  void library.sync();
});

const rescanTimer = setInterval(() => {
  void library.sync();
}, RESCAN_INTERVAL_MS);

function shutdown(signal: string): void {
  log(`${signal} を受信したため終了します`);
  clearInterval(rescanTimer);
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
