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
- `services/` — IPC service layer with co-located TanStack Query hooks (task.service, worktree.service, execution.service, project.service, connection.service, settings.service, integration.service, issue-tracking-lookup.service)
- `store/` — Zustand stores (boardStore, configStore, navigationStore, projectStore, sessionActivityStore)
- `contexts/` — React contexts (ConnectionContext, KanbanContext)
- `providers/` — Provider components (QueryProvider, ThemeProvider)
- `utils/` — hooks/ (useExecuteTask, useKeyboardNavigation, usePathNavigation, etc.; not TanStack Query — those live in services/), helpers/, constants/

**Rust backend (`src-tauri/src/`):**

- `ipc/` — Tauri command handlers, one file per domain (`task_handlers.rs`, `project_handlers.rs`, `worktree_handlers.rs`, `execution_handlers.rs`, `review_handlers.rs`, `acp_handlers.rs`, `ssh_handlers.rs`, `integration_handlers.rs`, `issue_tracking_handlers.rs`, `issue_tracking_lookup_handlers.rs`, `filesystem_handlers.rs`, `sftp_handlers.rs`, `settings_handlers.rs`)
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

Separate binary (must be on PATH). Acts as ACP intermediary between Tauri and AI agents. Communicates with Tauri via JSON-framed messages on stdin/stdout. Key files: `main.rs` (entry, message routing), `session_handler.rs` (ACP session lifecycle), `agent.rs` (subprocess spawn), `detection.rs` (agent discovery), `registry.rs` (session registry), `sessions.rs` (session types), `terminal.rs` (terminal I/O), `file_ops.rs` (file operations).

**maestro-protocol (`maestro-protocol/src/`):**

Shared crate defining the JSON message types between maestro (Tauri) and maestro-server.

**Cargo workspace:** Root `Cargo.toml` defines three members: `src-tauri`, `maestro-server`, `maestro-protocol`. Build from repo root with `cargo build` or from `src-tauri/` for the Tauri app only.

### Database Schema

SQLite with foreign key constraints enabled. Schema V19 (destructive migration on version mismatch). Configured with WAL mode and 5s `busy_timeout` for concurrent access.

Tables: `projects`, `tasks`, `task_relationships`, `task_instructions`, `task_attachments`, `worktrees`, `settings`, `task_reviews`, `review_comments`, `known_hosts`, `ssh_connections`, `wsl_connections`, `session_aliases`

### IPC Communication

All IPC uses TanStack Query — components never call `invoke()` directly. The pattern is:

```
Component → TanStack Query hook → service function (invoke()) → Rust #[tauri::command]
```

Service functions in `src/services/` wrap `invoke()` and export TanStack Query hooks directly (useQuery/useMutation co-located with the invoke call). `src/utils/hooks/` contains non-query custom hooks (keyboard nav, path nav, etc.). Rust handlers marked `#[tauri::command]`, split across domain files in `src-tauri/src/ipc/`, registered via `tauri-specta`'s `collect_commands![]` in `lib.rs`.

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
- Path aliases: `@/*` → `src/*`, `@/hooks` → `src/utils/hooks`, `@/lib` → `src/utils/helpers` (e.g. `@/lib/ui-utils`), `@/ui` → `src/components/ui/*`

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
- Schema version: 19. Migration is destructive (drops all tables on version mismatch)
- `maestro-protocol` crate shared between maestro and maestro-server
- Two-phase startup: settings load → project selection → main UI
- Foreign keys ensure referential integrity (CASCADE on delete)
- All IPC commands use `Arc<AppState>` for thread-safe DB access
- ACP sessions require `maestro-server` binary on PATH; absence surfaces as "maestro-server not found" in UI
- Schema migration drops all tables on version mismatch (no data preservation strategy)
- Projects have three connection types: local, SSH (via `ssh_connections`), WSL (via `wsl_connections`)
- Handlers needing both a `Project` and `GitConnection` use `get_project_with_git_conn()` from `db/connection.rs`
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
