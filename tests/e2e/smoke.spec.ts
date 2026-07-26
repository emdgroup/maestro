import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Smoke tests for the packaged app.
 *
 * These deliberately assert things the unit suite cannot reach: that the binary launches at all,
 * that `setup()` in main.rs built a usable SQLite database, and that a real IPC round-trip
 * returns. Anything provable against mocked IPC belongs in a vitest file instead.
 *
 * `browser`, `describe`, `it` and `expect` are globals injected by WebdriverIO; their types come
 * from @wdio/globals via tests/e2e/tsconfig.json.
 */

/**
 * IPC goes through `window.__TAURI__` (exposed because tauri.conf.json sets `withGlobalTauri`)
 * rather than the service's `browser.tauri.execute`. That wrapper needs the extra
 * `tauri-plugin-wdio` crate compiled in, and times out with "core.invoke not available" without
 * it; plain `browser.execute` reaches the same API and keeps one less plugin out of the build.
 */
function invoke<T>(command: string): Promise<T> {
  return browser.execute(
    (cmd) => (window as unknown as TauriGlobal).__TAURI__.core.invoke(cmd),
    command,
  ) as Promise<T>;
}

type TauriGlobal = {
  __TAURI__: {
    core: { invoke: (command: string) => Promise<unknown> };
    app: { getVersion: () => Promise<string> };
  };
};

describe("app launch", () => {
  it("opens a window titled Maestro", async () => {
    await expect(browser).toHaveTitle("Maestro");
  });

  it("renders the project picker rather than an error boundary", async () => {
    // Nothing is selected on a fresh data directory, so the picker is the expected first screen.
    // The tagline is a stable anchor: ProjectPicker.tsx renders it unconditionally.
    await expect(browser.$("h3=An agent orchestrator tool.")).toBeDisplayed();

    // The boot sequence surfaces backend failures as this banner instead of throwing, so a
    // rendered picker alone does not prove the backend came up.
    expect(await browser.$("body").getText()).not.toContain("Error loading settings");
  });

  it("offers the local connection", async () => {
    // Scoped to the span that actually holds the text — a bare `*=` match resolves to an
    // enclosing element that reports itself as not displayed.
    await expect(browser.$("span*=Browse local filesystem")).toBeDisplayed();
  });
});

describe("backend", () => {
  it("serves an IPC call from a database it created itself", async () => {
    // The real point of this lane. wdio.conf.ts points the app at an empty data directory, so
    // initialize_schema() just built the current schema from scratch; if that failed, or the
    // command never registered, this rejects rather than returning.
    const projects = await invoke<unknown[]>("get_projects");

    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toHaveLength(0);
  });

  it("is the binary built from the current source", async () => {
    const version = await browser.execute(() =>
      (window as unknown as TauriGlobal).__TAURI__.app.getVersion(),
    );

    // Guards against testing a stale binary left behind by an earlier build — the failure mode
    // `test:e2e:run` invites when it skips the compile step.
    const cargoToml = readFileSync(join(process.cwd(), "src-tauri", "Cargo.toml"), "utf8");
    const crateVersion = cargoToml.match(/^version = "(.+)"$/m)?.[1];

    expect(crateVersion).toBeDefined();
    expect(version).toBe(crateVersion);
  });
});
