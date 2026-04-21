Here's the compressed version:

# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project Overview

**Maestro** - Tauri desktop app orchestrating autonomous AI coding agents. Users manage tasks on Kanban board, agents execute in isolated git worktrees with real-time monitoring. React + TypeScript frontend, Rust backend.

See `.planning/PROJECT.md` for project goals, milestone progress, requirements.

## Development Commands

### Frontend Development

```bash
pnpm dev              # Start Vite dev server (port 5173)
pnpm build            # Build frontend (tsc + vite build + bundle verification)
pnpm preview          # Preview production build
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
pnpm tauri:dev        # Run Tauri app in dev mode (starts Vite + Tauri)
pnpm tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc      # Build production Tauri app
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
- **UI Components**: Radix UI (Dialog, Select), dnd-kit for drag-and-drop
- **Type Safety**: ts-rs for Rust → TypeScript type generation

### Code Structure

**Frontend (`src/`):**

- `App.tsx` - Main component, routing between views
- `views/` - Page views (AgentsView, KanbanView, ProjectPickerView, SettingsView, WorktreesView)
- `components/` - Reusable components by domain (kanban, task, project-picker, execution, common, ui)
- `contexts/` - React contexts (ConnectionContext, KanbanContext)
- `services/` - Tauri IPC wrappers (connection, execution, project, settings, task)
- `store/` - Zustand stores: boardStore, configStore, projectStore, reviewStore
- `utils/hooks/` - Custom React hooks
- `utils/helpers/` - Utility functions
- `types/bindings.ts` - Auto-generated TS types from Rust (via tauri-specta)

**Backend (`src-tauri/src/`):**

- `lib.rs` - Library entry, re-exports public modules
- `main.rs` - Tauri entry, registers IPC handlers
- `db/` - Database layer (SQLite connection, schema, settings)
  - `connection.rs` - DB init and AppState management
  - `schema.rs` - SQL schema (projects, tasks, worktrees, execution_logs, settings)
  - `settings.rs` - Settings persistence (load/save)
- `models/` - Domain models with Serialize/Deserialize/TS derives (task, project, worktree, execution_log, settings, review, sync, etc.)
- `ipc/` - IPC handlers split by domain
  - `project_handlers.rs`, `task_handlers.rs`, `worktree_handlers.rs`, `execution_handlers.rs`
  - `settings_handlers.rs`, `ssh_handlers.rs`, `filesystem_handlers.rs`, `review_handlers.rs`
- `git/` - Git ops; `mod.rs` dispatches via `GitConnection` enum, `remote.rs` runs local subprocess
- `ssh/` - SSH management (`session.rs` = RemoteSshSession, `password_manager.rs`, `error.rs`)
- `process/` - Agent execution: `spawner.rs` (local subprocess), `pty.rs` (local PTY), `remote.rs` (SSH)
- `websocket/` - WebSocket streaming (`streaming.rs`)
- `error.rs` - Custom error types

### Database Schema

SQLite with foreign key constraints enabled:

- **projects** - Project metadata (id, name, path, timestamps)
- **tasks** - Status, skills, acceptance criteria (refs project_id)
- **worktrees** - Git worktree instances (refs project_id)
- **execution_logs** - Command execution logs (refs task_id)
- **settings** - Key-value store (project_path, recent_projects, model_default, mcp_defaults, skills_defaults)

Timestamps are ISO 8601 RFC3339 strings. Skills stored as JSON arrays in TEXT columns.

### Type Safety Flow

Rust structs with `#[derive(TS)]` → auto-generate TS types in `src/types/bindings.ts` → imported by React components. Ensures frontend/backend type consistency.

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

### Tauri State

`AppState` (in `db/connection.rs`) holds runtime state injected into IPC handlers via `State<Arc<AppState>>`:

- `db: Mutex<Connection>` - SQLite connection (sync Mutex)
- `pty_sessions` - Local PTY sessions keyed by `execution_log.id` (`i32`)
- `ssh_pty_sessions` - Remote SSH PTY sessions keyed by `execution_log.id`
- `ssh_sessions` - Persistent SSH connections keyed by `connection_id` (`i32`)
- `ssh_passwords` - In-memory password store (zeroized on drop), keyed by `connection_id`
- `pty_attach_cancel` - Per-session cancel flags for PTY attach reader tasks

Use async `tokio::sync::Mutex` for session maps; sync `Mutex` only for DB connection.

### Git/SSH Dispatch

`GitConnection` enum in `models/connection.rs` routes git ops through single API in `git/mod.rs`:

```rust
pub enum GitConnection {
    Local { path: String },
    Remote { ssh: Arc<RemoteSshSession>, remote_path: String },
}
```

Pass `GitConnection` to git functions; dispatch to local subprocess or SSH channel is transparent. `run_git_in_dir` is primary local executor in `git/remote.rs`.

### Error Handling

- Rust functions return `Result<T, String>` for IPC commands
- DB errors mapped to strings for Tauri serialization
- Frontend shows errors in console (consider user-facing error UI)

### No Rust Logging

No `println!`, `eprintln!`, `tracing::`, or `log::` calls in Rust code. No logging infra wired up; debug via IPC return values or frontend console.

### Type Generation Workflow

When modifying Rust models:

1. Add/update struct with `#[derive(Serialize, Deserialize, TS)]` and `#[ts(export)]`
2. Set export dir in `Cargo.toml`: `export_dir = "../src/types"`
3. Run `pnpm tauri:gen` (runs `cargo test generate_typescript_bindings`)
4. TS types appear in `src/types/bindings.ts`
5. Import in React components

### Database Migrations

- Schema version tracked via `PRAGMA user_version`
- Current: `SCHEMA_VERSION = 10` in `src-tauri/src/db/schema.rs`
- Init checks version, applies migrations on first run
- Foreign keys enabled via `PRAGMA foreign_keys = ON`

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
- Skills stored as JSON-serialized Vec<String> in DB
- Two-phase startup: settings load → project selection → main UI
- Foreign keys ensure referential integrity (CASCADE on delete)
- All IPC commands use `Arc<AppState>` for thread-safe DB access