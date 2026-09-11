import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev:client` proxies API and media requests to `npm run dev:server`.
const apiTarget = `http://127.0.0.1:${process.env.PORT ?? "8792"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": apiTarget,
      "/media": apiTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
