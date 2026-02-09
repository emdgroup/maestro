# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**GSD Agent Orchestrator** - A Tauri desktop app for orchestrating autonomous AI coding agents. Users manage tasks on a Kanban board, agents execute them in isolated git worktrees with real-time monitoring. Built with React + TypeScript (frontend) and Rust (backend).

See `.planning/PROJECT.md` for detailed project goals, current milestone progress, and requirements.

## Development Commands

### Frontend Development
```bash
pnpm dev              # Start Vite dev server (port 5173)
pnpm build            # Build frontend (outputs to dist/)
pnpm preview          # Preview production build
```

### Tauri Development
```bash
pnpm tauri:dev        # Run Tauri app in dev mode (starts Vite + Tauri)
pnpm tauri build      # Build production Tauri app
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
- `App.tsx` - Main app component, handles project selection flow and settings
- `components/` - React components (KanbanBoard, TaskCard, TaskModal, ProjectPicker, etc.)
- `store/boardStore.ts` - Zustand store for task state management with Immer
- `types/bindings.ts` - Auto-generated TypeScript types from Rust (via ts-rs)

**Backend (`src-tauri/src/`):**
- `lib.rs` - Library entry point, re-exports all public modules
- `main.rs` - Tauri app entry point, registers IPC handlers
- `db/` - Database layer (SQLite connection, schema, settings)
  - `connection.rs` - Database initialization and AppState management
  - `schema.rs` - SQL schema definitions (projects, tasks, worktrees, execution_logs, settings)
  - `settings.rs` - Settings persistence (load/save operations)
- `models/` - Domain models with Serialize/Deserialize/TS derives
  - `task.rs` - Task model and TaskStatus enum
  - `project.rs` - Project model
  - `worktree.rs` - Worktree model and WorktreeStatus enum
  - `execution_log.rs` - ExecutionLog model and ExecutionStatus enum
  - `settings.rs` - AppSettings model
- `ipc/` - Tauri IPC command handlers
  - `handlers.rs` - All Tauri commands (get_projects, create_task, update_task, etc.)
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

Rust handlers in `src-tauri/src/ipc/handlers.rs` are marked with `#[tauri::command]` and registered in `main.rs`.

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
3. Build the Rust project (`cargo build`) to generate TypeScript types
4. TypeScript types appear in `src/types/bindings.ts`
5. Import and use in React components

### Database Migrations
- Schema version tracked via `PRAGMA user_version`
- Current version: `SCHEMA_VERSION = 1` in `src-tauri/src/db/schema.rs`
- Schema initialization checks version and applies migrations on first run
- Foreign keys are enabled via `PRAGMA foreign_keys = ON`

### Build-Time Mock Exclusion (Development vs Production)

**Pattern:** Use `import.meta.env.DEV` to gate development-only code that gets tree-shaken by Vite in production builds.

**Location:** `src/lib/tauri-mock.ts` and any imports in `src/main.ts`

**Why this matters:** Development uses mock IPC handlers to test without Tauri runtime. Production builds must exclude all mock code to avoid bundling unnecessary code.

**Implementation:**
- All mock invoke functions and mockDB are wrapped in `if (import.meta.env.DEV) { ... }`
- Vite statically replaces `import.meta.env.DEV` with `true` during dev, `false` during production build
- Tree-shaking removes `if (false)` branches entirely from production bundle
- Real Tauri fallback outside the DEV check always available for production

**Do NOT use runtime checks** like `if (isTauri) { real } else { mock }` — this includes mock code in production bundle because both branches are reachable at runtime.

**Verification:** Bundle analysis script (`scripts/verify-bundle.mjs`) runs after every production build and fails if mock markers found.

**Reference:** Phase 13 Bug Fixes (v1.1) — fixed mock leak by implementing this pattern.

## Project Conventions

### File Organization
- React components in `src/components/` (PascalCase filenames)
- Rust modules use snake_case filenames
- Store files in `src/store/` (camelCase with "Store" suffix)
- Generated types in `src/types/`

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
