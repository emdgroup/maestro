# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm dev              # Start Vite dev server (port 5173)
pnpm build            # TypeScript check + Vite production build
pnpm test             # Run Vitest unit tests
pnpm test <pattern>   # Run single test file (e.g. pnpm test usePathNavigation)
pnpm test:e2e         # Run Playwright E2E tests
pnpm test:e2e:ui      # Run Playwright tests with interactive UI
pnpm lint             # Run oxlint
pnpm lint:fix         # Auto-fix lint issues
pnpm format           # Check formatting with oxfmt
pnpm format:fix       # Fix formatting with oxfmt
```

### Tauri Development

```bash
pnpm tauri:dev        # Start Tauri dev mode (frontend + Rust backend)
pnpm tauri build      # Build production Tauri app
pnpm tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc      # Cross-compile for Windows
pnpm tauri:gen        # Regenerate TypeScript bindings from Rust models
```

### Rust Backend

```bash
cd src-tauri
cargo build           # Build Rust backend
cargo test            # Run Rust tests
cargo check           # Check compilation without building
```

## Code Search: Use the Knowledge Graph FIRST

**MANDATORY: Before using Grep, Glob, or Read to explore code, FIRST use code-review-graph MCP tools.**

This is a hard rule, not a suggestion. The graph has 1600+ indexed nodes with structural relationships — it finds callers, dependents, and test coverage in one call that would take 5+ Grep/Glob calls to reconstruct.

| Task                    | Use this tool                           |
| ----------------------- | --------------------------------------- |
| Find a function/class   | `semantic_search_nodes`                 |
| Trace callers / callees | `query_graph` (callers_of / callees_of) |
| Understand blast radius | `get_impact_radius`                     |
| Code review             | `detect_changes` → `get_review_context` |
| Architecture overview   | `get_architecture_overview`             |
| Find tests for a symbol | `query_graph` pattern="tests_for"       |

Fall back to Grep/Glob/Read **only** when the graph can't answer the question (e.g. searching for a specific string literal, reading a full file for context).

When falling back to text search, prefer `ast-grep` over `grep`/`ripgrep`. It understands syntax — searches by AST pattern, not regex. Useful for finding usages by structure (e.g., all calls to a function, all `match` arms on a type).

### Language flags for this project

| File type | Flag |
|-----------|------|
| `.tsx` React components | `--lang tsx` |
| `.ts` non-JSX files | `--lang typescript` |
| `.rs` Rust files | `--lang rust` |

### Working patterns

```bash
# Find all useState calls in React components
ast-grep --pattern 'useState($$$)' --lang tsx src/

# Find all for loops in Rust
ast-grep --pattern 'for $VAR in $ITER { $$$BODY }' --lang rust maestro-server/src/

# Find method calls in Rust
ast-grep --pattern '$OBJ.map_err($$$)' --lang rust src-tauri/src/
```

### Known quirks

**Language / file extension:**
- **TSX not TypeScript for component files.** `.tsx` files need `--lang tsx`; `--lang typescript` only scans `.ts` files. Wrong lang = zero results, no error.
- **`--lang typescript` scans `.ts` only; `--lang tsx` scans `.tsx` only.** Use the right one for the file extension. To search both, run two commands.

**Rust function declarations:**
- **`fn $NAME($$$)` fails with multi-line params.** Pattern requires params on one line. Workaround: search call-sites (`$EXPR.method($$$)`) or inner patterns (loops, `if let`, `match`) instead.
- **`impl $TRAIT for $TYPE` works**, but only when the impl body fits (multi-line bodies match fine via `$$$BODY`).

**TypeScript/TSX patterns that work reliably:**
- `import $NAME from "$MOD"` — default imports
- `import { $$$NAMES } from "$MOD"` — named imports
- `function $NAME($$$PARAMS) { $$$BODY }` — function declarations (including destructured params like `{ $$$PARAMS }: $TYPE`)
- `const { $$$FIELDS } = $EXPR` — object destructuring (single-line and multi-line both match)
- `const [$A, $B] = $EXPR` — array destructuring
- `await $EXPR` — await expressions
- `type $NAME = $TYPE` — type aliases
- `useState($$$)`, `useCallback($CB, [$$$DEPS])` — hook calls

**TypeScript/TSX patterns that do NOT work:**
- `const $NAME = ($$$PARAMS) => { $$$BODY }` — const arrow functions fail to match (even when they exist in the file)
- `useQuery({ $$$OPTS })` — object literal arg with space after `{` doesn't match; `useQuery($$$)` works fine
- `interface $NAME { $$$FIELDS }` — interfaces only match in `.ts` files, not `.tsx`; use `--lang typescript` on the right file

**General:**
- **Exit code 1 = no matches**, not an error. Don't treat non-zero exit as failure.
- **Pattern must match the full AST node.** Partial or structural mismatches fail silently. Use `--debug-query=pattern` to inspect how ast-grep parses your pattern.
- **Directory scans work** — pass a directory path, not just a file; ast-grep recurses.

Use `Grep` tool only for plain string literals or when ast-grep patterns would be overly complex.

## Architecture

### Tech Stack

- **Frontend**: React 19 + TypeScript, Vite build, Tailwind CSS 4.1
- **Backend**: Tauri 2 (Rust), SQLite for persistence
- **State Management**: Zustand with Immer middleware
- **UI Components**: shadcn/ui components
- **Data Fetching**: TanStack Query for all IPC operations (37+ hooks)
- **Type Safety**: ts-rs + tauri-specta for Rust → TypeScript type generation

### Code Structure

**Frontend (`src/`):**

- `views/` — top-level route views (KanbanView, AgentsView, WorktreesView, SettingsView, ProjectPickerView)
- `components/` — reusable UI components organized by domain (kanban/, execution/, task/, common/, ui/, views/)
  - `components/views/` — sub-view components rendered inside route views (BoardView, ArchiveView); distinct from top-level `src/views/`
- `services/` — IPC service layer wrapping `invoke()` calls (task.service, worktree.service, etc.)
- `store/` — Zustand stores (boardStore, configStore, navigationStore, projectStore, sessionActivityStore)
- `contexts/` — React contexts (ConnectionContext, KanbanContext)
- `providers/` — Provider components (QueryProvider, ThemeProvider)
- `utils/` — hooks/, helpers/, constants/

**Rust backend (`src-tauri/src/`):**

- `ipc/` — Tauri command handlers, one file per domain (`task_handlers.rs`, `project_handlers.rs`, `worktree_handlers.rs`, `execution_handlers.rs`, `review_handlers.rs`, `acp_handlers.rs`, `ssh_handlers.rs`, `integration_handlers.rs`, etc.)
- `models/` — Data models with ts-rs derive
- `db/` — SQLite schema, storage, migrations
- `acp/` — ACP session management (manager, registry, transport)
- `ssh/` — SSH connections (session, password manager)
- `git/` — Git remote operations
- `process/` — PTY/process spawning (local + remote)
- `streaming/` — WebSocket streaming to frontend
- `issue_tracking/` — provider-specific issue sync logic
- `wsl.rs` — WSL distro detection and connection helpers
- `project_lock.rs` — file-based single-instance project locking
- `error.rs` — shared error types

**maestro-server (`maestro-server/src/`):**

Separate binary (must be on PATH). Acts as ACP intermediary between Tauri and AI agents. Communicates with Tauri via JSON-framed messages on stdin/stdout.

**maestro-protocol (`maestro-protocol/src/`):**

Shared crate defining the JSON message types between maestro (Tauri) and maestro-server.

**Cargo workspace:** Root `Cargo.toml` defines three members: `src-tauri`, `maestro-server`, `maestro-protocol`. Build from repo root with `cargo build` or from `src-tauri/` for the Tauri app only.

### Database Schema

SQLite with foreign key constraints enabled. Schema V18 (destructive migration on version mismatch). Configured with WAL mode and 5s `busy_timeout` for concurrent access.

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `session_aliases`

### IPC Communication

All IPC uses TanStack Query — components never call `invoke()` directly. The pattern is:

```
Component → TanStack Query hook → service function (invoke()) → Rust #[tauri::command]
```

Service functions in `src/services/` wrap `invoke()`. Hooks in `src/utils/hooks/` wrap services via `useQuery`/`useMutation`. Rust handlers marked `#[tauri::command]`, split across domain files in `src-tauri/src/ipc/`, registered via `tauri-specta`'s `collect_commands![]` in `lib.rs`.

## Key Patterns

### State Management

- Zustand with Immer middleware for state updates (see `boardStore.ts`)
- Immer allows direct mutations in reducers (proxied to immutable updates)
- Store exposes action methods (loadTasks, updateTaskStatus, addTask) and selectors (getTasks, getTasksByStatus)

### Error Handling

- Rust functions return `Result<T, String>` for IPC commands
- DB errors mapped to strings for Tauri serialization
- Frontend shows errors in console (consider user-facing error UI)

### No Rust Logging

No `tracing::`, or `log::` calls in Rust code. No logging infra wired up; debug via IPC return values or frontend console.

### Type Generation Workflow

When modifying Rust models:

1. Run `pnpm tauri:gen` (runs `cargo test generate_typescript_bindings`)
2. TS types appear in `src/types/bindings.ts`
3. Import in React components

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
- Path aliases: `@/*` → `src/*`, `@/hooks` → `src/utils/hooks`, `@/lib` → `src/utils/helpers`, `@/ui` → `src/components/ui/*`

### Naming

- Rust: snake_case functions/variables, PascalCase types/enums
- TypeScript/React: camelCase functions/variables, PascalCase components/types
- Database: snake_case tables and columns

### Status Enums

- TaskStatus: Backlog, Ready, InProgress, Review, Done
- Serialized PascalCase in JSON (`#[serde(rename_all = "PascalCase")]`)
- Used for Kanban column organization

## Configuration Files

- `tauri.conf.json` - Tauri config (window size, bundle, build commands)
- `vite.config.ts` - Vite config (port 5173, HMR port 5174 for remote dev)
- `tsconfig.json` - TypeScript strict mode
- `Cargo.toml` - Rust deps and ts-rs export config

## Important Notes

- SQLite DB location managed by Tauri app data directory
- Schema version: 18. Migration is destructive (drops all tables on version mismatch)
- `maestro-protocol` crate shared between maestro and maestro-server
- Two-phase startup: settings load → project selection → main UI
- Foreign keys ensure referential integrity (CASCADE on delete)
- All IPC commands use `Arc<AppState>` for thread-safe DB access
- ACP sessions require `maestro-server` binary on PATH; absence surfaces as "maestro-server not found" in UI
- Schema migration drops all tables on version mismatch (no data preservation strategy)
- Projects have three connection types: local, SSH (via `ssh_connections`), WSL (via `wsl_connections`)
- Handlers needing both a `Project` and `GitConnection` use `get_project_with_git_conn()` from `db/connection.rs`
- `AcpState` manages: active sessions, discovery cache, connection servers, agent cache, session pool, deploy locks, restorable sessions

# Rust coding guidelines

- Prioritize code correctness and clarity. Speed and efficiency are secondary priorities unless otherwise specified.
- Do not write organizational or comments that summarize the code. Comments should only be written in order to explain "why" the code is written in some way in the case there is a reason that is tricky / non-obvious.
- Prefer implementing functionality in existing files unless it is a new logical component. Avoid creating many small files.
- Avoid using functions that panic like `unwrap()`, instead use mechanisms like `?` to propagate errors.
- Be careful with operations like indexing which may panic if the indexes are out of bounds.
- Never silently discard errors with `let _ =` on fallible operations. Always handle errors appropriately:
  - Propagate errors with `?` when the calling function should handle them
  - Use `.log_err()` or similar when you need to ignore errors but want visibility
  - Use explicit error handling with `match` or `if let Err(...)` when you need custom logic
  - Example: avoid `let _ = client.request(...).await?;` - use `client.request(...).await?;` instead
- When implementing async operations that may fail, ensure errors propagate to the UI layer so users get meaningful feedback.
- For new modules, prefer flat files (`src/some_module.rs`) over `src/some_module/mod.rs`. Existing `mod.rs` files in `ipc/`, `models/`, `db/` are legacy — don't refactor them, but don't add new ones.
- When creating new crates, prefer specifying the library root path in `Cargo.toml` using `[lib] path = "...rs"` instead of the default `lib.rs`, to maintain consistent and descriptive naming (e.g., `gpui.rs` or `main.rs`).
- Avoid creative additions unless explicitly requested
- Use full words for variable names (no abbreviations like "q" for "queue")
- Use variable shadowing to scope clones in async contexts for clarity, minimizing the lifetime of borrowed references.
  Example:
  ```rust
  executor.spawn({
      let task_ran = task_ran.clone();
      async move {
          *task_ran.borrow_mut() = true;
      }
  });
  ```

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
