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
bun run test:e2e      # Run Playwright E2E tests
bun run test:e2e:ui   # Run Playwright tests with interactive UI
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

SQLite with foreign key constraints enabled. Schema V24. Configured with WAL mode and 5s `busy_timeout` for concurrent access.

`SCHEMA_VERSION` lives in `src-tauri/src/core/schema.rs` — that constant is the source of truth; update this doc when you bump it.

`initialize_schema()` picks one of three paths based on `PRAGMA user_version`:

| Stored version      | Behaviour                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `0` (fresh install) | create the full schema from `SCHEMA_V24_FULL`                              |
| `>= 22`             | apply incremental migrations in `run_migrations()` — **data is preserved** |
| `1..=21` (legacy)   | drop every table and recreate — **data is lost**                           |

So bumping `SCHEMA_VERSION` does _not_ wipe user data. Add a `migrate_to_vN()` function and
extend `run_migrations()` with a matching `if from < N` guard; use `CREATE TABLE IF NOT EXISTS`
and check `pragma_table_info` before `ALTER TABLE` so the step is safe to re-run. Only databases
predating v22 still take the drop path.

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `task_attachments`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `docker_connections`, `session_aliases`

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

### No Rust Logging

No `tracing::`, or `log::` calls in Rust code. No logging infra wired up; debug via IPC return values or frontend console.

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

- SQLite DB location managed by Tauri app data directory
- Schema version: 24 (`SCHEMA_VERSION` in `core/schema.rs`). Databases at v22 or later migrate in place and keep their data; only pre-v22 databases are dropped and recreated
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

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
