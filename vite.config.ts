/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  // The Tauri CLI exports TAURI_ENV_DEBUG only for debug builds, so this is true
  // for `tauri dev` and `tauri build --debug` and false for a release bundle.
  // Inlining it means the release bundle carries no native-context-menu bypass at all.
  define: {
    __TAURI_DEBUG_BUILD__: JSON.stringify(process.env.TAURI_ENV_DEBUG === "true"),
  },
  resolve: {
    // Sonner and React DOM must resolve React to this application's single
    // module instance. Without this, the macOS WebKit bundle can load a second
    // copy and trigger React's "Invalid hook call" error at startup.
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
  },
  test: {
    include: ["./src/**/*.{test,spec}.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // `.maestro/` too, which matters when Maestro is run against its own repository: creating a
      // worktree puts a whole second checkout at `.maestro/worktrees/<name>/`, and the `index.html`
      // and `tsconfig.json` inside it made Vite clear its cache and hard-reload the app — tearing
      // down the very IPC call that was creating the worktree. `.maestro/` is gitignored,
      // project-local state (dev database, worktrees, bundled binaries); none of it is source.
      ignored: ["**/src-tauri/**", "**/.maestro/**"],
    },
  },
}));
