# End-to-end tests

These drive the **real** Maestro binary through WebdriverIO — real Rust backend, real SQLite,
real webview. They are the only tests that can catch "the app does not start".

They need a display and a compiled binary, so they are not part of `bun run test` and not wired
into CI. A desktop session works; so does a headless machine under `xvfb-run`, which is how the
suite was verified.

## Prerequisites

| Requirement    | Notes                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A display      | An X11/Wayland session, or `xvfb-run` (see below)                                                                                                                                 |
| WebKitGTK      | Linux only — the webview the app renders in                                                                                                                                       |
| Rust toolchain | Needed to build the binary under test                                                                                                                                             |
| Node 20+       | Must be on `PATH`. WebdriverIO's CJS entry does not resolve under bun, and the Vite build needs `util.styleText`, added in Node 20. The scripts themselves still run through bun. |

On Debian/Ubuntu:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev webkit2gtk-driver xvfb
```

The default `embedded` driver runs the WebDriver server inside the app itself, so no separate
`tauri-driver` install is required.

## Running

```bash
bun run test:e2e          # builds the binary with the wdio feature, then runs the suite
bun run test:e2e:run      # skips the build, reuses the binary already in target/release
```

Headless machine with no display:

```bash
xvfb-run -a bun run test:e2e
```

## How the binary is built

```
tauri build --no-bundle -- --features wdio
```

Two things in that command matter, and both were mistakes worth not repeating.

**It must go through the Tauri CLI, not `cargo build --release`.** A plain cargo release build
produces a binary that still points at `devUrl` — it loads `http://localhost:5173` instead of the
bundled frontend. That fails outright with no dev server running, and, far worse, _passes_ while
silently testing the dev server if one happens to be running. If the suite passes for you but
fails on a clean machine, read `location.href` inside the app before anything else.

**`--features wdio` is what registers `tauri_plugin_wdio_webdriver`** in `main.rs`. That plugin
exposes an automation server able to drive the UI and reach every IPC command, so it is not part
of a default build — `cargo tree -i tauri-plugin-wdio-webdriver` finds nothing without the flag.
Never ship a binary built with it.

Because the flag changes the binary, one left over from an ordinary build will not accept a
WebDriver connection. `test:e2e` rebuilds for that reason; `test:e2e:run` assumes you know the
binary is current, and the version assertion in `smoke.spec.ts` is the backstop.

## Your data is not touched — except on macOS

The app opens whatever database lives in its app-data directory. Run naively, the suite would
migrate and write to your real Maestro install.

`wdio.conf.ts` therefore points the OS data directory at a fresh temp directory per run and
deletes it afterwards, so every run starts from an empty schema — which is also what makes the
`get_projects` assertion meaningful.

**On macOS this protection does not work.** Tauri derives the directory from `$HOME` there, and
overriding `$HOME` breaks keychain access. Back up `~/Library/Application Support/com.maestro.app`
before running the suite on a Mac, or accept that it runs against your real data.

## Scope

Keep these tests thin. Anything provable against mocked IPC belongs in a vitest file next to the
component — those run in CI on every commit; these do not. The bar for adding a case here is
"this can only fail in the real binary": process launch, schema creation on a fresh database, IPC
registration, window lifecycle.

## Known gaps

- Not run in CI. Nothing stops these from rotting except someone running them.
- The updater plugin fires a network request at boot. It does not currently fail the suite, but
  it is a plausible source of flakes on a poor connection.
- Only the launch path is covered. Project creation needs a real git repository fixture and a
  path through the picker's native file dialog, which WebDriver cannot drive.
