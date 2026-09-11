/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(async () => ({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  // TAURI_ENV_DEBUG is set for `tauri dev` and `--debug` builds only, so the release bundle
  // inlines `false` and carries no native-context-menu bypass.
  define: {
    __TAURI_DEBUG_BUILD__: JSON.stringify(process.env.TAURI_ENV_DEBUG === "true"),
  },
  resolve: {
    // A second React copy in the macOS WebKit bundle throws "Invalid hook call" at startup.
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  test: {
    include: ["./src/**/*.{test,spec}.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },

  // Keep Rust errors on screen; Tauri expects the dev server on a fixed port.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // `.maestro/` holds the dev database and worktree checkouts, whose `index.html` hard-reloads
      // the app mid-worktree-creation. Relative to this file, not a `**/.maestro/**` glob: that
      // matched every path of a dev server started inside a worktree and killed its HMR.
      ignored: (file) =>
        ["src-tauri", ".maestro"].includes(path.relative(projectRoot, file).split(path.sep)[0]),
    },
  },
}));
