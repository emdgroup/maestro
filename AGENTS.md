# AGENTS.md

This file provides guidance to harness such as Claude Code (claude.ai/code) when working with code in this repository.

1. Don’t assume. Don’t hide confusion. Surface tradeoffs.

2. Minimum code that solves the problem. Nothing speculative.

3. Touch only what you must. Clean up only your own mess.

4. Define success criteria. Loop until verified.

## Project Overview

**Maestro** - Tauri desktop app orchestrating autonomous AI coding agents. Users manage tasks on Kanban board, agents execute in isolated git worktrees with real-time monitoring. React + TypeScript frontend, Rust backend.

See `.planning/PROJECT.md` for project goals, milestone progress, requirements.

## Development Commands

### Frontend Development

```bash
bun run dev           # Start Vite dev server (port 5173)
bun run build         # TypeScript check + Vite production build
bun run test          # Run Vitest unit tests
bun run test <pattern>   # Run single test file (e.g. bun run test usePathNavigation)
bun run test:e2e      # Build the real binary and run the WebdriverIO E2E suite (needs a display)
bun run lint          # Run oxlint
bun run lint:fix      # Auto-fix lint issues
bun run format        # Check formatting with oxfmt
bun run format:fix    # Fix formatting with oxfmt
```

### Tauri Development

```bash
bun run tauri:dev     # Start Tauri dev mode (frontend + Rust backend)
bun run tauri build   # Build production Tauri app
bun run tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc      # Cross-compile for Windows
bun run tauri:gen     # Regenerate TypeScript bindings from Rust models
```

### Rust Backend

```bash
cd src-tauri
cargo build           # Build Rust backend
cargo test            # Run Rust tests
cargo check           # Check compilation without building
```

## Architecture

### Tech Stack

- **Frontend**: React 19 + TypeScript, Vite build, Tailwind CSS 4.1
- **Backend**: Tauri 2 (Rust), SQLite for persistence
- **State Management**: Zustand with Immer middleware
- **UI Components**: shadcn/ui components
- **Data Fetching**: TanStack Query for all IPC operations (100+ hooks co-located in service files)
- **Type Safety**: ts-rs + tauri-specta for Rust → TypeScript type generation

### Code Structure

**Frontend (`src/`):**

- `views/` — top-level route views (KanbanView, AgentsView, WorktreesView, SettingsView, ProjectPickerView)
- `components/` — reusable UI components organized by domain (kanban/, execution/, task/, common/, ui/, views/)
  - `components/views/` — sub-view components rendered inside route views (BoardView, ArchiveView); distinct from top-level `src/views/`
- `services/` — IPC service layer with co-located TanStack Query hooks (task.service, worktree.service, execution.service, project.service, connection.service, settings.service, integration.service, integration-lookup.service, acp-auth.service, canvas.service)
- `store/` — Zustand stores (boardStore, configStore, navigationStore, projectStore, reviewStore, sessionActivityStore, shortcutStore)
- `contexts/` — React contexts (ConnectionContext, KanbanContext)
- `providers/` — Provider components (QueryProvider, ThemeProvider)
- `utils/` — hooks/ (useExecuteTask, useKeyboardNavigation, usePathNavigation, etc.; not TanStack Query — those live in services/), helpers/, constants/

**Rust backend (`src-tauri/src/`):**

Code is organized by **domain**, not by layer. Each domain module owns its own
handlers (`handlers.rs` or `*_handlers.rs`), models (`models.rs` or `*_models.rs`),
and logic, so a feature touches one directory rather than three.

- `core/` — cross-cutting foundations: `schema.rs` (SQLite schema + migration), `settings.rs`, `connection.rs` (incl. `get_project_with_git_conn()`), `project_storage.rs`, `AppState`
- `project/` — project CRUD, handlers, models, `git_ops.rs`, `lock.rs` (file-based single-instance locking), `session_state.rs`, `prime.rs`
- `task/` — task CRUD, handlers, models, `relationships.rs`, `instructions.rs`, `attachments.rs`, `ops.rs`
- `git/` — worktree lifecycle/query/staging, `merge.rs`, `review.rs`, diff + review models and handlers, `remote.rs`
- `acp/` — ACP session management: `manager.rs`, `registry.rs`, `transport*.rs`, `reader_task.rs`, `deploy.rs`, `canvas.rs`, and session/prompt/discovery/file/meta/auth handlers
- `execution/` — PTY/process spawning (local + remote), `queue.rs`, `streaming.rs`, handlers, models
- `connectivity/` — SSH (`ssh/`), WSL, Docker, SFTP, filesystem handlers, connection models
- `integration/` — issue-tracking providers (`providers/`), `lookup/`, `issue_sync.rs`, `keychain.rs`, `token_manager.rs`
- `settings/` — app settings handlers and models
- `error.rs` — shared `MaestroError` type
- `ipc/mod.rs`, `models/mod.rs` — thin re-export shims only (no code), kept so `lib.rs`'s `collect_commands![]` and older `crate::models::*` paths keep resolving. New code should import from the owning domain module directly.

**maestro-server (`maestro-server/src/`):**

Separate binary (must be on PATH). Acts as ACP intermediary between Tauri and AI agents. Communicates with Tauri via JSON-framed messages on stdin/stdout. Key files: `main.rs` (entry), `dispatch.rs` (message routing), `session/` (`handlers.rs` ACP session lifecycle, `connection.rs`, `command_loop.rs`), `sessions.rs` (session types), `agent/` (`spawn.rs` subprocess spawn, `detection.rs` agent discovery, `registry.rs` agent registry), `agent_restart.rs`, `terminal.rs` (terminal I/O), `file_ops.rs` (file operations), `validate_canvas.rs`, `tool_check.rs`.

**maestro-protocol (`maestro-protocol/src/`):**

Shared crate defining the JSON message types between maestro (Tauri) and maestro-server.

**Cargo workspace:** Root `Cargo.toml` defines three members: `src-tauri`, `maestro-server`, `maestro-protocol`. Build from repo root with `cargo build` or from `src-tauri/` for the Tauri app only.

### Database Schema

SQLite with foreign key constraints enabled. Schema V25. Configured with WAL mode and 5s `busy_timeout` for concurrent access.

`SCHEMA_VERSION` lives in `src-tauri/src/core/schema.rs` — that constant is the source of truth; update this doc when you bump it.

`initialize_schema()` picks one of three paths based on `PRAGMA user_version`:

| Stored version      | Behaviour                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `0` (fresh install) | create the full schema from `SCHEMA_V25_FULL`                              |
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

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `task_attachments`, `task_comments`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `docker_connections`, `session_aliases`

### IPC Communication

All IPC uses TanStack Query — components never call `invoke()` directly. The pattern is:

```
Component → TanStack Query hook → service function (invoke()) → Rust #[tauri::command]
```

Service functions in `src/services/` wrap `invoke()` and export TanStack Query hooks directly (useQuery/useMutation co-located with the invoke call). `src/utils/hooks/` contains non-query custom hooks (keyboard nav, path nav, etc.). Rust handlers marked `#[tauri::command]` live in the handler file of their owning domain module (e.g. `task/handlers.rs`, `git/review_handlers.rs`, `acp/session_handlers.rs`); `ipc/mod.rs` re-exports them all so `lib.rs` can register them via `tauri-specta`'s `collect_commands![]` (currently ~171 commands).

`src/types/bindings.ts` is fully generated — do not edit manually. It exports both TypeScript types (all Rust model structs/enums annotated with `#[derive(TS)]`) and a `commands` const object (typed wrappers for every registered IPC command). Import types with `import type { Task } from "@/types/bindings"`.

### View Rendering

`App.tsx` renders the four main views (`KanbanView`, `AgentsView`, `WorktreesView`, `SettingsView`) as lazily-loaded modules using `React.lazy()`. Only the active view is visible; tab transitions animate using `framer-motion`'s `useAnimationControls`. `navigationStore` drives `activeTab` and `slideDirection`.

`KanbanView` renders either `<TaskDetailScreen>` (when `activeTaskId` is set) or the board + action bar. The `BoardView` inside renders all five columns and owns the `ReviewModal` and `ExecutionTerminal` drawer.

### Zustand Stores — Roles

| Store                  | Purpose                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boardStore`           | `activeTerminalTaskId` and `isTerminalOpen` — drives the bottom terminal drawer in `BoardView`                                                                |
| `navigationStore`      | Tab routing (`activeTab`), view-to-view slide direction, `activeTaskId` for task detail screen, `pendingAgentId`/`pendingWorktreeId` for deep-link navigation |
| `projectStore`         | Selected project reference; `useSelectedProject()` is the canonical way to get `projectId`/`projectPath`                                                      |
| `reviewStore`          | Diff data, selected file, and loading state for `ReviewModal`                                                                                                 |
| `sessionActivityStore` | Per-execution live status (`spawning` / `thinking` / `acting` / `awaiting`) shown in `AgentActivityPanel`                                                     |
| `configStore`          | App-wide settings (theme, model defaults) cached from Tauri                                                                                                   |

### Contexts

- `KanbanContext` — provides `projectId`, `projectPath`, `onTaskClick` to the kanban component subtree (avoids prop-drilling through `BoardView → KanbanColumn → TaskCard`)
- `ConnectionContext` — provides active `Connection` (local vs SSH vs WSL) and connection ID to the project picker subtree

## Key Patterns

### State Management

- Zustand with Immer middleware for state updates (see `boardStore.ts`)
- Immer allows direct mutations in reducers (proxied to immutable updates)
- Store exposes action methods (loadTasks, updateTaskStatus, addTask) and selectors (getTasks, getTasksByStatus)

### Error Handling

- Rust functions return `Result<T, String>` for IPC commands
- DB errors mapped to strings for Tauri serialization
- Frontend shows errors in console (consider user-facing error UI)

### base-ui Component Pitfall

Tabs and Popover in `src/components/ui/` are from `@base-ui-components/react`, **not Radix UI**. The base-ui `Trigger` component has no `asChild` prop. To render a custom element as a trigger, use `buttonVariants()` directly on the element instead:

```tsx
// WRONG — asChild does not exist on base-ui Trigger
<PopoverTrigger asChild><Button>Open</Button></PopoverTrigger>

// CORRECT
<PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
  Open
</PopoverTrigger>
```

### The dev data directory (`MAESTRO_DATA_DIR`)

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

### Rust logging

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
The `validate-canvas` subcommand and `--version` are genuine CLI output and correctly use
`println!`/`eprintln!`.

### End-to-end tests and the `wdio` feature

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

### Type Generation Workflow

When modifying Rust models:

1. Run `bun run tauri:gen` (runs `cargo test generate_typescript_bindings`)
2. TS types appear in `src/types/bindings.ts`
3. Import in React components

Note: `generate_typescript_bindings` also runs as part of `cargo test -p maestro --lib`, so any
Rust test run rewrites `src/types/bindings.ts` — as unformatted output, which then differs from the
oxfmt-formatted committed copy. A diff there after running tests is usually formatting churn, not a
stale-bindings signal; compare the exported command/type names before assuming it is out of date.

### Bundled ACP agent registry

`maestro-server/src/assets/registry.json` is vendored: it is committed, `include_str!`'d by
`agent/registry.rs`, and never fetched during a build. Entries in it decide which executable and
arguments `maestro-server` spawns, so treat changes to `package`, `version`, `args`, `cmd` and
`archive` fields as supply-chain changes and review them as such.

Refresh it through the `Update agent registry` workflow (weekly, or run it manually), which
fetches, validates and opens a pull request. Do not reintroduce a build-time fetch: writing to the
tracked file on every build made builds unreproducible and let agent version bumps ride along in
unrelated commits.

**Never add a hand-written entry to `registry.json`, and never synthesize an agent in
`registry.rs`.** Anything the bundled list does not cover — a local gateway, an internal adapter,
the same adapter with different environment variables — is user configuration and belongs in
`~/.maestro/custom-agents.json` on the machine that runs the agent, merged by
`registry::apply_custom_agents` (see below). Hardcoding one costs a release per variant and, since
`detection.rs` has no entry for it, a matching special case in the host's discovery filter.

### User-defined ACP agents (`~/.maestro/custom-agents.json`)

Same schema as `registry.json`, on the machine `maestro-server` runs on — the remote home for SSH,
WSL and container connections, next to the `tools.json` that `tool_config.rs` already reads there.

It is re-read on every `ListAgents` and `DetectInstalledAgents` rather than at startup, so an agent
added mid-session appears without restarting the server; the host's five-minute discovery cache is
what still delays it in the UI. Entries are additive — an id colliding with a bundled agent is
rejected and logged, so a typo cannot shadow a working agent. There is no detection table entry for
a custom agent, so `maestro-server` reports it as installed unconditionally and a wrong command
surfaces as a spawn failure instead of a silently missing picker entry.

The `maestro-custom-agents` skill (`src-tauri/assets/skills/`) is what writes this file: it is
installed onto every connection alongside `maestro-output`, and interviews the user before writing.
It carries `disable-model-invocation: true`, so it only runs when the user types
`/maestro-custom-agents` — writing to a file outside the project on a model's own initiative is not
something to do behind the user's back. Its schema documentation and Ollama recipe are user-facing
and mirrored in the README; keep both in step with `resolve_spawn`.

### Project-Local Storage (`.maestro/`)

Each project has a `.maestro/` folder in its root with:

- `settings.json` — `ProjectConfig` (non-sensitive project settings)
- `state.json` — `ProjectState` (runtime/cached state)
- `bin/` — bundled `maestro-server` binary for that project
- `attachments/` — agent file attachments

Read/write via `project_storage.rs`. Follow this pattern when adding new project-scoped config (e.g., ticketing config goes in `.maestro/ticketing.json`).

## Project Conventions

### File Organization

- React components in `src/components/` (PascalCase filenames)
- Rust modules snake_case filenames
- Stores in `src/store/` (camelCase + "Store" suffix)
- Generated types in `src/types/`

### Import Conventions

- Direct imports; barrel `index.ts` files removed from all domain dirs
- Path aliases: `@/*` → `src/*`, `@/hooks` → `src/utils/hooks`, `@/lib` → `src/utils/helpers` (e.g. `@/lib/ui-utils`), `@/ui` → `src/components/ui/*`

### Naming

- Rust: snake_case functions/variables, PascalCase types/enums
- TypeScript/React: camelCase functions/variables, PascalCase components/types
- Database: snake_case tables and columns

### Status Enums

- TaskStatus: Planning, Queue, InProgress, Review, Done
- Serialized PascalCase in JSON (`#[serde(rename_all = "PascalCase")]`)
- Used for Kanban column organization

## Configuration Files

- `tauri.conf.json` - Tauri config (window size, bundle, build commands)
- `vite.config.ts` - Vite config (port 5173, HMR port 5174 for remote dev)
- `tsconfig.json` - TypeScript strict mode
- `Cargo.toml` - Rust deps and ts-rs export config

## Important Notes

- SQLite DB location managed by Tauri app data directory, overridable with `MAESTRO_DATA_DIR` (see below)
- Schema version: 25 (`SCHEMA_VERSION` in `core/schema.rs`). Databases at v22 or later migrate in place and keep their data; only pre-v22 databases are dropped and recreated
- `maestro-protocol` crate shared between maestro and maestro-server
- Two-phase startup: settings load → project selection → main UI
- Foreign keys ensure referential integrity (CASCADE on delete)
- All IPC commands use `Arc<AppState>` for thread-safe DB access
- ACP sessions require `maestro-server` binary on PATH; absence surfaces as "maestro-server not found" in UI
- Projects have three connection types: local, SSH (via `ssh_connections`), WSL (via `wsl_connections`)
- Handlers needing both a `Project` and `GitConnection` use `get_project_with_git_conn()` from `core/connection.rs`
- `AcpState` manages: active sessions, discovery cache, connection servers, agent cache, session pool, deploy locks, restorable sessions

# Pull request hygiene

When an agent opens or updates a pull request, it must:

- Use a clear, correctly capitalized, imperative PR title (for example, `Fix crash in project panel`).
- Avoid conventional commit prefixes in PR titles (`fix:`, `feat:`, `docs:`, etc.).
- Avoid trailing punctuation in PR titles.
- Optionally prefix the title with a crate name when one crate is the clear scope (for example, `git_ui: Add history view`).
- Include a `Release Notes:` section as the final section in the PR body.
- Use one bullet under `Release Notes:`:
  - `- Added ...`, `- Fixed ...`, or `- Improved ...` for user-facing changes, or
  - `- N/A` for docs-only and other non-user-facing changes.
- Format release notes exactly with a blank line after the heading, for example:

```
Release Notes:

- N/A
```

## MCP Tools: codegraph

**This project has a pre-indexed knowledge graph. Call `codegraph_explore`
BEFORE Grep/Glob/Read when exploring the codebase.** It returns the verbatim
source of the relevant symbols plus the call paths between them in one capped
call, which is cheaper and more structurally aware than a search/Read loop.

The index covers the whole workspace from the repo root — frontend (`src/`) and
all three Rust crates (`src-tauri`, `maestro-server`, `maestro-protocol`) are in
one graph, so no `projectPath` argument is needed.

### The only exposed tool

`codegraph_explore` is the entire MCP surface — there is no separate search,
callers, or impact tool registered. Do not invent tool names; anything else
must be done with Grep/Glob/Read.

| Param         | Use                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`       | Required. Symbol/file names (`"AcpState session_handlers deploy"`) or a natural-language question. For a flow, name the symbols spanning it. |
| `maxFiles`    | Optional, default 12. Raise when surveying a broad area.                                                                                     |
| `projectPath` | Optional. Only for querying a codebase outside this repo.                                                                                    |

### Rules

- **Treat returned source as already Read.** Do not re-open those files — that
  discards the whole point of the call.
- Reach for it when asking how something works, where something lives, what a
  change will affect, or what you are about to edit.
- Fall back to Grep/Glob/Read when the graph misses — non-code assets, config,
  markdown, generated files, and anything the parser did not resolve.
- Rust extraction is the weaker half of this graph (its cross-file resolution
  trails TS/TSX). Verify with Grep before relying on a negative result — "no
  callers found" in Rust is not proof there are none.

### Freshness

A file watcher syncs the graph automatically; there is no update hook and
nothing to run by hand. Two caveats:

- If a response carries a **staleness banner** naming files with pending edits,
  read those files directly rather than trusting the shown source.
- On Windows, NTFS access-time updates can make plain reads look like edits, so
  those banners may appear spuriously (upstream issue #1451). The following
  sync is a harmless no-op.

Run `codegraph sync` only if auto-sync reports itself disabled; `codegraph
status` shows index state.
