import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const PYPROJECT_VERSION_REGEX = /^\s*version\s*=\s*"([^"]+)"/m;

function readKimiCliVersion(): string {
  const fallback = process.env.KIMI_CLI_VERSION ?? "dev";
  const pyprojectPath = path.resolve(__dirname, "../pyproject.toml");

  try {
    const pyproject = fs.readFileSync(pyprojectPath, "utf8");
    const match = pyproject.match(PYPROJECT_VERSION_REGEX);
    if (match?.[1]) {
      return match[1];
    }
  } catch (error) {
    console.warn("[vite] Unable to read version", pyprojectPath, error);
  }

  return fallback;
}

const kimiCliVersion = readKimiCliVersion();
const shouldAnalyze = process.env.ANALYZE === "true";

// https://vite.dev/config/
export default defineConfig({
  // Use relative paths so assets work under any base path.
  base: "./",
  plugins: [
    nodePolyfills({
      include: ["path", "url"],
    }),
    react(),
    tailwindcss(),
    ...(shouldAnalyze
      ? [
          visualizer({
            brotliSize: true,
            filename: "dist/bundle-report.html",
            gzipSize: true,
            open: false,
            template: "treemap",
          }),
        ]
      : []),
  ],
  define: {
    __KIMI_CLI_VERSION__: JSON.stringify(kimiCliVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ai-elements": path.resolve(__dirname, "./src/components/ai-elements"),
    },
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:5494",
        changeOrigin: true,
        ws: true, // Enable WebSocket proxy
      },
    },
  },
});
