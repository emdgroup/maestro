# AGENTS.md

This file provides guidance to harness such as Claude Code (claude.ai/code) when working with code in this repository.

1. Don’t assume. Don’t hide confusion. Surface tradeoffs.

2. Minimum code that solves the problem. Nothing speculative.

3. Touch only what you must. Clean up only your own mess.

4. Define success criteria. Loop until verified.

## Project Overview

**Maestro** - Tauri desktop app orchestrating autonomous AI coding agents. Users manage tasks on Kanban board, agents execute in isolated git worktrees with real-time monitoring. React + TypeScript frontend, Rust backend.

See `.planning/PROJECT.md` for project goals, milestone progress, requirements.

`docs/automations-plan.md` is the working plan for the Automations feature and the resident
`maestro-server` it runs on. It is phased, and each phase records the decisions already locked, so
read it before touching the daemon, session lifetime, or automation storage.

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
cargo test            # Run Rust tests (see below on Windows)
cargo check           # Check compilation without building
```

Formatting is a workspace-level concern, so it runs from the repo root rather than `src-tauri/`,
and has scripts alongside the frontend's `format`/`format:fix` so both halves are driven the same
way:

```bash
bun run format:rust       # Check formatting with rustfmt
bun run format:rust:fix   # Fix formatting with rustfmt
```

There is no `rustfmt.toml`: the settings are stock rustfmt, and the absence of a config file is
what keeps them that way. The tree was reformatted wholesale once, in `613fcabf`, after having
drifted to 1349 unformatted hunks across 148 of 161 files — run `format:rust` before pushing so
that does not have to happen twice. CI runs both scripts, so neither half can drift again.

**`.oxfmtrc.json` ignores what release-please writes.** `CHANGELOG.md`,
`.release-please-manifest.json` and `src-tauri/tauri.conf.json` are machine-written on every
release and cannot be kept formatted. The config file lists only `$.version` as an extra-file
path for `tauri.conf.json`, which reads like a targeted edit, but release-please's JSON updater
parses the whole document and re-serializes it with `JSON.stringify(data, null, 2)` — the 0.24.0
release expanded two single-line arrays that way. Formatting any of the three lasts until the next
release and then turns the release pull request red, which is why they are ignored rather than
fixed. `src/types/bindings.ts` is on that list for the same reason: a generator owns it.

**On Windows, `cargo test` does not work — use this instead:**

```bash
MAESTRO_TEST_MANIFEST=1 cargo test --lib
```

Both halves are required. Without the environment variable every test binary dies at load with
`STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) before a single test runs, because `tauri_build` links
the Common-Controls v6 manifest into bin targets only and the dialog plugin's
`TaskDialogIndirect` does not exist in the ComCtl32 5.82 the loader falls back to. Without `--lib`
the bin's own harness is built too, gets the resource twice, and the link fails with LNK1123. The
full reasoning, and why this cannot simply be always-on, is in `src-tauri/build.rs`.

The same failure takes out `bun run tauri:gen`, which goes through
`cargo test generate_typescript_bindings` — so on Windows regenerate bindings with
`MAESTRO_TEST_MANIFEST=1 cargo test --lib generate_typescript_bindings` rather than the script.

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
- `project/` — project CRUD, handlers, models, `git_ops.rs`, `lock.rs` (asks the connection's daemon for the project lock, and for takeovers), `session_state.rs`, `prime.rs`
- `task/` — task CRUD, handlers, models, `relationships.rs`, `instructions.rs`, `attachments.rs`, `ops.rs`
- `git/` — worktree lifecycle/query/staging, `merge.rs`, `review.rs`, diff + review models and handlers, `remote.rs`
- `acp/` — ACP session management: `manager.rs`, `registry.rs`, `transport*.rs`, `reader_task.rs`, `deploy.rs`, `replay.rs`, `host_tools.rs`, and session/prompt/discovery/file/meta/auth handlers
- `execution/` — PTY/process spawning (local + remote), `queue.rs`, `streaming.rs`, handlers, models
- `connectivity/` — SSH (`ssh/`), WSL, Docker, SFTP, filesystem handlers, connection models
- `integration/` — issue-tracking providers (`providers/`), `lookup/`, `issue_sync.rs`, `keychain.rs`, `token_manager.rs`
- `settings/` — app settings handlers and models
- `error.rs` — shared `MaestroError` type
- `ipc/mod.rs`, `models/mod.rs` — thin re-export shims only (no code), kept so `lib.rs`'s `collect_commands![]` and older `crate::models::*` paths keep resolving. New code should import from the owning domain module directly.

**maestro-server (`maestro-server/src/`):**

Separate binary (must be on PATH). Acts as ACP intermediary between Tauri and AI agents. Communicates with Tauri via JSON-framed messages on stdin/stdout. Key files: `main.rs` (entry), `dispatch.rs` (message routing), `session/` (`handlers.rs` ACP session lifecycle, `connection.rs`, `command_loop.rs`), `sessions.rs` (session types), `agent/` (`spawn.rs` subprocess spawn, `detection.rs` agent discovery, `registry.rs` agent registry), `agent_restart.rs`, `terminal.rs` (terminal I/O), `file_ops.rs` (file operations), `mcp_gateway.rs` + `mcp_stdio.rs` (Maestro's own MCP server, see
`maestro-server/AGENTS.md`), `tool_check.rs`.

**maestro-protocol (`maestro-protocol/src/`):**

Shared crate defining the JSON message types between maestro (Tauri) and maestro-server.

**Cargo workspace:** Root `Cargo.toml` defines three members: `src-tauri`, `maestro-server`, `maestro-protocol`. Build from repo root with `cargo build` or from `src-tauri/` for the Tauri app only.

### Domain notes live beside the code

Each part of the tree carries its own `AGENTS.md`, loaded when an agent works in that directory.
Read the one for the area you are about to change. Do not add a `CLAUDE.md` anywhere in the tree:
Claude Code (v2.1.277+) reads `AGENTS.md` itself, and only while no `CLAUDE.md` or
`CLAUDE.local.md` sits on the path, so one stray file silently drops every note below.

| File                       | Covers                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/AGENTS.md`            | View rendering, stores, contexts, the base-ui pitfall, reading cron expressions, canvas surfaces                                                                                     |
| `src-tauri/AGENTS.md`      | Database schema and migrations, `MAESTRO_DATA_DIR`, Rust logging, the `wdio` feature, `.maestro/` project storage                                                                    |
| `maestro-server/AGENTS.md` | The resident daemon, project locks, automations and their worktrees, webhooks, the Maestro MCP server, Collections (skills and MCP servers), the bundled and custom agent registries |
| `website/AGENTS.md`        | The home page video                                                                                                                                                                  |

Two rules from those files apply everywhere: log through the `log` crate (never `eprintln!`, and
raw ACP frames only at `trace`), and never ship a binary built with `--features wdio`.

### IPC Communication

All IPC uses TanStack Query — components never call `invoke()` directly. The pattern is:

```
Component → TanStack Query hook → service function (invoke()) → Rust #[tauri::command]
```

Service functions in `src/services/` wrap `invoke()` and export TanStack Query hooks directly (useQuery/useMutation co-located with the invoke call). `src/utils/hooks/` contains non-query custom hooks (keyboard nav, path nav, etc.). Rust handlers marked `#[tauri::command]` live in the handler file of their owning domain module (e.g. `task/handlers.rs`, `git/review_handlers.rs`, `acp/session_handlers.rs`); `ipc/mod.rs` re-exports them all so `lib.rs` can register them via `tauri-specta`'s `collect_commands![]` (currently ~187 commands).

`src/types/bindings.ts` is fully generated — do not edit manually. It exports both TypeScript types (all Rust model structs/enums annotated with `#[derive(TS)]`) and a `commands` const object (typed wrappers for every registered IPC command). Import types with `import type { Task } from "@/types/bindings"`.

## Key Patterns

### State Management

- Zustand with Immer middleware for state updates (see `boardStore.ts`)
- Immer allows direct mutations in reducers (proxied to immutable updates)
- Store exposes action methods (loadTasks, updateTaskStatus, addTask) and selectors (getTasks, getTasksByStatus)

### Error Handling

- Rust functions return `Result<T, String>` for IPC commands
- DB errors mapped to strings for Tauri serialization
- Frontend shows errors in console (consider user-facing error UI)

### Type Generation Workflow

When modifying Rust models:

1. Run `bun run tauri:gen` (runs `cargo test generate_typescript_bindings`)
2. TS types appear in `src/types/bindings.ts`
3. Import in React components

Note: `generate_typescript_bindings` also runs as part of `cargo test -p maestro --lib`, so any Rust
test run rewrites `src/types/bindings.ts`. `.oxfmtrc.json` lists the file under `ignorePatterns`, so
the committed copy is the generator's own output and a test run leaves it alone unless the bindings
genuinely changed — a diff there means a model changed and should be committed.

## Project Conventions

### File Organization

- React components in `src/components/` (PascalCase filenames)
- Rust modules snake_case filenames
- Stores in `src/store/` (camelCase + "Store" suffix)
- Generated types in `src/types/`

### Import Conventions

- Direct imports; barrel `index.ts` files removed from all domain dirs
- Path aliases: `@/*` → `src/*`, `@/hooks/*` → `src/utils/hooks/*`, `@/lib/*` → `src/utils/helpers/*` (e.g. `@/lib/utils`), `@/ui/*` → `src/components/ui/*`
- **Write the short form.** The three targeted aliases all sit under `src/`, so the long spelling
  (`@/utils/helpers/…`, `@/components/ui/…`, `@/utils/hooks/…`) resolves too — and two spellings
  for one path means every search for a module's importers needs two patterns. Omit the file
  extension as well: `@/lib/utils`, not `@/lib/utils.ts`. `no-restricted-imports` in
  `.oxlintrc.json` enforces both.

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

- SQLite DB location managed by Tauri app data directory, overridable with `MAESTRO_DATA_DIR` (see `src-tauri/AGENTS.md`)
- Schema version: 30 (`SCHEMA_VERSION` in `core/schema.rs`). Databases at v22 or later migrate in place and keep their data; only pre-v22 databases are dropped and recreated
- `maestro-protocol` crate shared between maestro and maestro-server; `PROTOCOL_VERSION` is 7.
  Bumping it redeploys `maestro-server` on every connection at first use, because `deploy.rs`
  compares `--app-version`, which embeds it
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
