# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

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

## Architecture

### Tech Stack

- **Frontend**: React 19 + TypeScript, Vite build
- **Backend**: Tauri 2 (Rust), SQLite for persistence
- **State Management**: Zustand with Immer middleware
- **UI Components**: Base UI (Dialog, Select)
- **Type Safety**: ts-rs for Rust → TypeScript type generation

### Code Structure

**Frontend (`src/`):**
- `views/` — top-level route views (KanbanView, AgentsView, WorktreesView, SettingsView, ProjectPickerView)
- `components/` — reusable UI components organized by domain (kanban/, execution/, task/, common/, ui/)
- `services/` — IPC service layer wrapping `invoke()` calls (task.service, worktree.service, etc.)
- `store/` — Zustand stores (boardStore, configStore, navigationStore, projectStore, sessionActivityStore)
- `contexts/` — React contexts (ConnectionContext, KanbanContext)
- `providers/` — Provider components (QueryProvider, ThemeProvider)
- `utils/` — hooks/, helpers/, constants/

**Rust backend (`src-tauri/src/`):**
- `ipc/` — Tauri command handlers by domain
- `models/` — Data models with ts-rs derive
- `db/` — SQLite schema, storage, migrations
- `acp/` — ACP session management (manager, registry, transport)
- `ssh/` — SSH connections (session, password manager)
- `git/` — Git remote operations
- `process/` — PTY/process spawning (local + remote)
- `websocket/` — WebSocket streaming to frontend

**maestro-server (`maestro-server/src/`):**

Separate binary (must be on PATH). Acts as ACP intermediary between Tauri and AI agents. Communicates with Tauri via JSON-framed messages on stdin/stdout.

**maestro-protocol (`maestro-protocol/src/`):**

Shared crate defining the JSON message types between maestro (Tauri) and maestro-server.

### Database Schema

SQLite with foreign key constraints enabled. Schema V12 (destructive migration on version mismatch).

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `worktrees`, `execution_logs`, `ssh_connections`, `settings`, `acp_sessions`, `acp_messages`, `reviews`, `review_changes`

### IPC Communication

Frontend invokes Rust commands via `@tauri-apps/api/core`:

```typescript
import { invoke } from "@tauri-apps/api/core";
const tasks = await invoke<Task[]>("get_tasks", { projectId: 1 });
```

Rust handlers marked `#[tauri::command]`, split across domain files in `src-tauri/src/ipc/`, registered via `tauri-specta` in `lib.rs`.

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
- Schema version: 12. Migration is destructive (drops all tables on version mismatch)
- `maestro-protocol` crate shared between maestro and maestro-server
- Two-phase startup: settings load → project selection → main UI
- Foreign keys ensure referential integrity (CASCADE on delete)
- All IPC commands use `Arc<AppState>` for thread-safe DB access
- ACP sessions require `maestro-server` binary on PATH; absence surfaces as "maestro-server not found" in UI
- Schema migration drops all tables on version mismatch (no data preservation strategy)


# Rust coding guidelines

* Prioritize code correctness and clarity. Speed and efficiency are secondary priorities unless otherwise specified.
* Do not write organizational or comments that summarize the code. Comments should only be written in order to explain "why" the code is written in some way in the case there is a reason that is tricky / non-obvious.
* Prefer implementing functionality in existing files unless it is a new logical component. Avoid creating many small files.
* Avoid using functions that panic like `unwrap()`, instead use mechanisms like `?` to propagate errors.
* Be careful with operations like indexing which may panic if the indexes are out of bounds.
* Never silently discard errors with `let _ =` on fallible operations. Always handle errors appropriately:
  - Propagate errors with `?` when the calling function should handle them
  - Use `.log_err()` or similar when you need to ignore errors but want visibility
  - Use explicit error handling with `match` or `if let Err(...)` when you need custom logic
  - Example: avoid `let _ = client.request(...).await?;` - use `client.request(...).await?;` instead
* When implementing async operations that may fail, ensure errors propagate to the UI layer so users get meaningful feedback.
* For new modules, prefer flat files (`src/some_module.rs`) over `src/some_module/mod.rs`. Existing `mod.rs` files in `ipc/`, `models/`, `db/` are legacy — don't refactor them, but don't add new ones.
* When creating new crates, prefer specifying the library root path in `Cargo.toml` using `[lib] path = "...rs"` instead of the default `lib.rs`, to maintain consistent and descriptive naming (e.g., `gpui.rs` or `main.rs`).
* Avoid creative additions unless explicitly requested
* Use full words for variable names (no abbreviations like "q" for "queue")
* Use variable shadowing to scope clones in async contexts for clarity, minimizing the lifetime of borrowed references.
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

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**This project has a code knowledge graph. Use code-review-graph MCP tools before Grep/Glob/Read.** Faster, fewer tokens, gives structural context (callers, dependents, test coverage).

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
