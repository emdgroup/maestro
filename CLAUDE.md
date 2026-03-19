# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Maestro** - A Tauri desktop app for orchestrating autonomous AI coding agents. Users manage tasks on a Kanban board, agents execute them in isolated git worktrees with real-time monitoring. Built with React + TypeScript (frontend) and Rust (backend).

See `.planning/PROJECT.md` for detailed project goals, current milestone progress, and requirements.

## Development Commands

### Frontend Development

```bash
pnpm dev              # Start Vite dev server (port 5173)
pnpm build            # Build frontend (tsc + vite build + bundle verification)
pnpm preview          # Preview production build
pnpm test             # Run Vitest unit tests
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

- `App.tsx` - Main app component, handles routing between views
- `views/` - Top-level page views (AgentsView, KanbanView, ProjectPickerView, SettingsView, WorktreesView)
- `components/` - Reusable components organized by domain (kanban, task, project-picker, execution, common, ui)
- `contexts/` - React contexts (ConnectionContext, KanbanContext)
- `services/` - Service layer wrapping Tauri IPC (connection, execution, project, settings, task)
- `store/` - Zustand stores: boardStore, configStore, projectStore, reviewStore
- `utils/hooks/` - Custom React hooks
- `utils/helpers/` - Utility functions
- `types/bindings.ts` - Auto-generated TypeScript types from Rust (via tauri-specta)

**Backend (`src-tauri/src/`):**

- `lib.rs` - Library entry point, re-exports all public modules
- `main.rs` - Tauri app entry point, registers IPC handlers
- `db/` - Database layer (SQLite connection, schema, settings)
  - `connection.rs` - Database initialization and AppState management
  - `schema.rs` - SQL schema definitions (projects, tasks, worktrees, execution_logs, settings)
  - `settings.rs` - Settings persistence (load/save operations)
- `models/` - Domain models with Serialize/Deserialize/TS derives (task, project, worktree, execution_log, settings, review, sync, etc.)
- `ipc/` - Tauri IPC command handlers split by domain
  - `project_handlers.rs`, `worktree_handlers.rs`, `execution_handlers.rs`
  - `settings_handlers.rs`, `ssh_handlers.rs`, `filesystem_handlers.rs`, `review_handlers.rs`
- `git/` - Git operations
- `ssh/` - SSH connection management (client, session, password manager)
- `process/` - Agent CLI process spawning, including PTY sessions
- `websocket/` - WebSocket communication
- `error.rs` - Custom error types for the app

### Database Schema

SQLite database with foreign key constraints enabled:

- **projects** - Project metadata (id, name, path, timestamps)
- **tasks** - Tasks with status, skills, acceptance criteria (references project_id)
- **worktrees** - Git worktree instances (references project_id)
- **execution_logs** - Command execution logs (references task_id)
- **settings** - Key-value settings store (project_path, recent_projects, model_default, mcp_defaults, skills_defaults)

All timestamps are ISO 8601 RFC3339 strings. Skills are stored as JSON arrays in TEXT columns.

### Type Safety Flow

Rust structs with `#[derive(TS)]` → auto-generate TypeScript types in `src/types/bindings.ts` → imported by React components. This ensures frontend/backend type consistency.

### IPC Communication

Frontend invokes Rust commands via `@tauri-apps/api/core`:

```typescript
import { invoke } from "@tauri-apps/api/core";
const tasks = await invoke<Task[]>("get_tasks", { projectId: 1 });
```

Rust handlers are marked with `#[tauri::command]`, split across domain-specific files in `src-tauri/src/ipc/`, and registered via `tauri-specta` in `lib.rs`.

## Key Patterns

### State Management

- Use Zustand with Immer middleware for state updates (see `boardStore.ts`)
- Immer allows direct state mutations in reducers (proxied to immutable updates)
- Store provides action methods (loadTasks, updateTaskStatus, addTask) and selector methods (getTasks, getTasksByStatus)

### Tauri State

- `AppState` contains Mutex-wrapped SQLite connection
- Injected into IPC handlers via `State<Arc<AppState>>`
- Always lock the mutex before database operations

### Error Handling

- Rust functions return `Result<T, String>` for IPC commands
- Database errors are mapped to strings for Tauri serialization
- Frontend displays errors in console (consider adding user-facing error UI)

### Type Generation Workflow

When modifying Rust models:

1. Add/update struct with `#[derive(Serialize, Deserialize, TS)]` and `#[ts(export)]`
2. Configure export directory in `Cargo.toml`: `export_dir = "../src/types"`
3. Run `pnpm tauri:gen` to generate TypeScript types (runs `cargo test generate_typescript_bindings`)
4. TypeScript types appear in `src/types/bindings.ts`
5. Import and use in React components

### Database Migrations

- Schema version tracked via `PRAGMA user_version`
- Current version: `SCHEMA_VERSION = 1` in `src-tauri/src/db/schema.rs`
- Schema initialization checks version and applies migrations on first run
- Foreign keys are enabled via `PRAGMA foreign_keys = ON`

## Project Conventions

### File Organization

- React components in `src/components/` (PascalCase filenames)
- Rust modules use snake_case filenames
- Store files in `src/store/` (camelCase with "Store" suffix)
- Generated types in `src/types/`

### Import Conventions

- Use direct imports; barrel `index.ts` files have been removed from all domain directories
- Use path aliases `@/hooks`, `@/lib` for hooks and helpers, `@/ui` for UI components (see `tsconfig.json` for full alias map)

### Naming

- Rust: snake_case for functions/variables, PascalCase for types/enums
- TypeScript/React: camelCase for functions/variables, PascalCase for components/types
- Database: snake_case for tables and columns

### Status Enums

- TaskStatus: Backlog, Ready, InProgress, Review, Done
- Serialized as PascalCase in JSON (`#[serde(rename_all = "PascalCase")]`)
- Used for Kanban column organization

## Configuration Files

- `tauri.conf.json` - Tauri app configuration (window size, bundle settings, build commands)
- `vite.config.ts` - Vite configuration (port 5173, HMR on port 5174 for remote dev)
- `tsconfig.json` - TypeScript strict mode enabled
- `Cargo.toml` - Rust dependencies and ts-rs export configuration

## Important Notes

- SQLite database file location is managed by Tauri's app data directory
- Skills are stored as JSON-serialized Vec<String> in the database
- The app uses a two-phase startup: settings loading → project selection → main UI
- Foreign key constraints ensure referential integrity (CASCADE on delete)
- All IPC commands use Arc<AppState> for thread-safe database access
