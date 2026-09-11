import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  host: string;
  port: number;
  mediaRoot: string;
  dataDir: string;
  distDir: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const home = os.homedir();
  const port = Number(env.PORT ?? "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT が不正です: ${env.PORT}`);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    mediaRoot: path.resolve(
      env.MEDIA_ROOT ?? path.join(home, "ClaudeCode", "PROJECT-MARIN", "output"),
    ),
    dataDir: path.resolve(
      env.DATA_DIR ?? path.join(home, "Library", "Application Support", "Media Viewer"),
    ),
    distDir: path.resolve(env.DIST_DIR ?? path.join(REPO_ROOT, "dist")),
  };
}

export function databasePath(config: Pick<ServerConfig, "dataDir">): string {
  return path.join(config.dataDir, "ratings.sqlite3");
}
