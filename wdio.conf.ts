import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E against the real binary: real Rust backend, real SQLite, real webview.
 *
 * Run it with `bun run test:e2e`, which builds the binary first. See tests/e2e/README.md —
 * this cannot run headless in a container, it needs a display and WebKitGTK.
 */

/**
 * Cargo puts the binary at the *workspace* root, not under src-tauri/, because this repo is a
 * three-crate workspace. The service spawns this path verbatim and no longer resolves binaries
 * itself, so pointing at src-tauri/target would fail with a bare ENOENT.
 */
const APP_BINARY =
  process.env.MAESTRO_E2E_BINARY ?? join(process.cwd(), "target", "release", "maestro");

/**
 * The app opens whatever database lives in its app-data directory. Without this the suite would
 * run against — and migrate, and write to — the real Maestro install of whoever ran it. Point
 * the OS-specific data directory at a throwaway so every run starts from an empty schema.
 *
 * Linux and Windows resolve that directory from the environment, so this works. macOS derives it
 * from $HOME and overriding that breaks keychain access, so on macOS the suite still uses the
 * real directory — see tests/e2e/README.md before running it there.
 */
/**
 * This module is evaluated once in the launcher and again in every worker, so minting a
 * directory unconditionally would create one per process — leaving the app using a worker's
 * copy while onComplete deleted the launcher's. Recording it in the environment makes the
 * launcher's directory the one workers inherit, and the one that gets cleaned up.
 */
function isolatedAppDataDir(): string {
  const existing = process.env.MAESTRO_E2E_DATA_DIR;
  if (existing) return existing;
  const created = mkdtempSync(join(tmpdir(), "maestro-e2e-"));
  process.env.MAESTRO_E2E_DATA_DIR = created;
  return created;
}

const appDataDir = isolatedAppDataDir();

const isolatedEnv: Record<string, string> =
  process.platform === "win32"
    ? { APPDATA: appDataDir, LOCALAPPDATA: appDataDir }
    : { XDG_DATA_HOME: appDataDir, XDG_CONFIG_HOME: appDataDir };

// The app inherits its environment from the driver, which inherits it from this process.
Object.assign(process.env, isolatedEnv);

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/e2e/**/*.spec.ts"],

  /**
   * One at a time. `project/lock.rs` takes a file lock per project and the whole suite shares a
   * single SQLite file, so parallel workers would fight over both.
   */
  maxInstances: 1,

  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: APP_BINARY },
    } as WebdriverIO.Capabilities,
  ],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: APP_BINARY,
        env: isolatedEnv,
        // Surface Rust panics and console errors in the WDIO output — with no logging in the
        // Rust code, a crash is otherwise a silent, unexplained session failure.
        captureBackendLogs: true,
        captureFrontendLogs: true,
        // Cold start pays for SQLite schema creation and the ACP discovery sweep.
        startTimeout: 120_000,
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  mochaOpts: { ui: "bdd", timeout: 120_000 },

  /**
   * The picker slides between its connections and projects panels, and the outgoing one is
   * `invisible` mid-transition. The default 3s can expire inside that window on a slow machine,
   * so element assertions get a wider budget — they still return as soon as the element settles.
   */
  waitforTimeout: 15_000,

  onComplete() {
    rmSync(appDataDir, { recursive: true, force: true });
  },
};
