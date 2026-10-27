import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages serves the site at https://<user>.github.io/mermantics/. The dev server
  // stays at the root.
  base: command === "build" || isPreview ? "/mermantics/" : "/",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The logo and favicon come from the repo root (assets/).
  server: { fs: { allow: [".."] } },
  worker: { format: "es" },
  // Mermaid's large chunks are diagram types and layouts that only load when used.
  build: { chunkSizeWarningLimit: 2000 },
}));
