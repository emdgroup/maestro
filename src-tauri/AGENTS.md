# Tauri backend (`src-tauri/`)

Notes for working in this directory. The repository-wide rules are in the root `AGENTS.md`. The host end of the daemon's features (`acp/host_tools.rs`,
`acp/automation_tools.rs`, `templates.rs`, `prompts.rs`, `collections/`, `project/lock.rs`) is
described in `maestro-server/AGENTS.md`, beside the daemon half.

## Database Schema

SQLite with foreign key constraints enabled. Schema V30. Configured with WAL mode and 5s `busy_timeout` for concurrent access.

`SCHEMA_VERSION` lives in `src-tauri/src/core/schema.rs` — that constant is the source of truth; update this doc when you bump it.

`initialize_schema()` picks one of three paths based on `PRAGMA user_version`:

| Stored version      | Behaviour                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `0` (fresh install) | create the full schema from `SCHEMA_V30_FULL`                              |
| `>= 22`             | apply incremental migrations in `run_migrations()` — **data is preserved** |
| `1..=21` (legacy)   | drop every table and recreate — **data is lost**                           |

So bumping `SCHEMA_VERSION` does _not_ wipe user data. Add a `migrate_to_vN()` function and
extend `run_migrations()` with a matching `if from < N` guard; use `CREATE TABLE IF NOT EXISTS`
and check `pragma_table_info` before `ALTER TABLE` so the step is safe to re-run. Only databases
predating v22 still take the drop path.

**An unreleased version may be rewritten rather than superseded.** The pipeline rework was built
as v25, v26 and v27 and collapsed back into a single v25, because none of them ever shipped —
v24 is what released builds carry. Three migrations for a state no database outside this
repository was ever in is three code paths maintained to serve nobody. This is only safe while
the versions in question are absent from `main` and from every tag; check both before doing it,
and expect to delete `.maestro/dev-data/` on any machine that ran the intermediate builds.

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `task_attachments`, `task_comments`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `docker_connections`, `session_aliases`, `connection_settings`, `templates`, `prompts`, `prompt_favorites`

## The dev data directory (`MAESTRO_DATA_DIR`)

`bun run tauri:dev` sets `MAESTRO_DATA_DIR=$PWD/.maestro/dev-data`, so a development build keeps
its `maestro.db` and its `locks/` inside the checkout instead of the OS app-data directory.

This is not a convenience. A database is only readable by the build that wrote it or a newer one —
`initialize_schema` refuses a `user_version` above `SCHEMA_VERSION`. Without the override every
checkout shares one file, so the moment any worktree carrying a schema migration is launched, every
other build stops starting with "created by a newer version of Maestro". The same collision
happens over `locks/`, where a dev build and the installed app contend for the same project.

`resolve_data_dir` in `src-tauri/src/main.rs` reads it, creates the directory, and treats a blank
value as unset — the convention `logging::resolve_log_dir` already follows, because an empty string
used as a path drops the database in the process working directory. The path is taken literally, so
the script passes an absolute one (`$PWD` expands under Bun Shell on every platform); a relative
value would resolve against the spawned binary's cwd, which is `src-tauri/`, not the repo root.

`.maestro/` is gitignored, so the dev database is never committed. Delete `.maestro/dev-data/` to
start from an empty one. Release builds set nothing and use the OS location as before.

## Rust logging

Use the `log` crate — `log::error!`, `warn!`, `info!`, `debug!`, `trace!`. Do not use `tracing::`,
and do not add `eprintln!` or `println!` for diagnostics: a bundled app has no terminal attached,
so anything on stderr is discarded and a user cannot send it to you.

`tauri-plugin-log` is wired up in `core/logging.rs`; `main.rs` only calls into it. It writes to
stderr and to `Maestro.log` in a directory the user can choose. Rotation is 5 MB per file keeping
two archives **alongside** the live one — three files, a ~15 MB ceiling, no age-based purge.

The default directory is Tauri's `app_log_dir()`, passed through untouched — note macOS has no
trailing `logs` segment, which is Tauri's convention and not something to "fix":

| Platform | Default                                |
| -------- | -------------------------------------- |
| Linux    | `~/.local/share/com.maestro.app/logs/` |
| macOS    | `~/Library/Logs/com.maestro.app/`      |
| Windows  | `%LOCALAPPDATA%\com.maestro.app\logs\` |

`resolve_log_dir` exists only to choose between that default and the user's override, and to treat
a blank setting as unset — a blank string used as a path would drop the log file in the process
working directory.

**The logger is installed from `setup()`, not the builder chain**, because the level and directory
come from the settings table and the database is only open by then. The cost is that records
emitted before `setup` — other plugins' initialisation — are dropped. Do not "fix" this by moving
the plugin back into the builder: it would take the user's configuration with it.

Level resolution is `MAESTRO_LOG` → the stored `log_level` setting → `info`, with an unparseable
value falling through rather than failing. Dependencies are pinned at `warn`, because at `debug`
`keyring`, `rustls` and `reqwest` bury everything we write.

The user-selected level applies **without a restart**, and the mechanism matters: fern's own
filtering is fixed once built, so `core/logging.rs` lets our crates through at `trace` via two
`level_for` entries (`maestro` for `main.rs`, `maestro_lib` for the rest) and does the real gating
with `log::set_max_level`. A new crate in the workspace needs its own `level_for` entry or it will
sit at `warn`. A directory change cannot work this way and needs a restart — `get_log_directory`
returns the active and configured paths separately so the UI can say so rather than pointing a
user at a folder that is still empty.

Picking a level:

| Level   | Use for                                                                     |
| ------- | --------------------------------------------------------------------------- |
| `error` | The user's action failed and the app cannot recover it                      |
| `warn`  | A best-effort step failed — a dropped event emit, an unreachable connection |
| `info`  | Once-per-run facts: startup, version, chosen paths                          |
| `debug` | Session and connection lifecycle                                            |
| `trace` | Per-message and per-heartbeat detail                                        |

**Raw ACP frames stay at `trace`.** `transport_types.rs` and `reader_task.rs` serialise whole
protocol messages, which carry prompt text, agent output and the contents of files the agent
read. `trace` is off by default and that is the only thing keeping that content out of a file
users attach to bug reports. Do not promote those sites, and do not log message bodies at a
level above `trace`.

`maestro-server` is a separate process, spawned with a null stderr on one transport path, so its
`eprintln!` output goes nowhere. Report from there with `helpers::send_diag(level, message)`,
which forwards over the protocol's `Diagnostic` message; the host re-logs it at a matching level.
The `mcp` subcommand and `--version` are genuine CLI output and correctly use
`println!`/`eprintln!` — the shim speaks JSON-RPC on stdout to the agent that spawned it, not to
the host.

## End-to-end tests and the `wdio` feature

`tests/e2e/` drives the **real** binary through WebdriverIO — real Rust backend, real SQLite,
real webview. It needs a display and is **not** in CI, so it only runs when someone runs it. See
`tests/e2e/README.md`. Keep it thin: anything provable against mocked IPC belongs in a vitest
file, which does run per commit.

The suite depends on the `wdio` Cargo feature, which registers `tauri_plugin_wdio_webdriver` in
`main.rs`. That plugin exposes an automation server able to drive the UI and call every IPC
command, so it is optional and off by default — verify with
`cargo tree -i tauri-plugin-wdio-webdriver`, which finds nothing without `--features wdio`.
**Never ship a binary built with that flag**, and do not move the dependency out of `[features]`
to match upstream's example, which is a throwaway test app.

## Project-Local Storage (`.maestro/`)

Each project has a `.maestro/` folder in its root with:

- `settings.json` — `ProjectConfig` (non-sensitive project settings)
- `state.json` — `ProjectState` (runtime/cached state)
- `bin/` — bundled `maestro-server` binary for that project
- `attachments/` — agent file attachments

Read/write via `project_storage.rs`. Follow this pattern when adding new project-scoped config (e.g., ticketing config goes in `.maestro/ticketing.json`).
