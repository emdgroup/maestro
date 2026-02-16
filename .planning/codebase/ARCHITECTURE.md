# Architecture

**Analysis Date:** 2026-02-14

## Pattern Overview

**Overall:** Layered architecture with desktop app frontend and Tauri/Rust backend, communicating via IPC (Inter-Process Communication). The application uses two-phase startup: settings loading → project selection → main UI. Task execution is orchestrated across local and remote systems via git worktrees.

**Key Characteristics:**
- Frontend-driven UI state management with Zustand (Immer middleware)
- Backend-driven persistence via SQLite with foreign key constraints
- IPC bridge via Tauri commands with strong TypeScript type safety (ts-rs)
- Dual execution paths: local (PTY-based) and remote (SSH-based)
- Stateful session management for PTY and SSH connections
- Three distinct project types: local, remote via SSH, and Git connections

## Layers

**Presentation Layer:**
- Purpose: React components for UI rendering and user interaction
- Location: `src/components/`, `src/providers/`
- Contains: Page components (KanbanBoard, ProjectPicker, SettingsPage), UI primitives (shadcn/ui), page-specific components (TaskCard, KanbanColumn, TaskModal)
- Depends on: Zustand store (boardStore, reviewStore, configStore), theme provider, component hooks
- Used by: ThemeProvider wraps entire App.tsx for global theme state

**State Management Layer:**
- Purpose: Client-side state handling for tasks, execution, reviews, and configuration
- Location: `src/store/`
- Contains: Three Zustand stores with Immer middleware for immutable updates
  - `boardStore.ts`: Task CRUD, execution lifecycle (spawn, pause, resume, abort), terminal state
  - `reviewStore.ts`: Code review state and diff parsing
  - `configStore.ts`: Configuration state
- Depends on: Tauri invoke API (`@tauri-apps/api/core`)
- Used by: All components via hooks (useBoardStore, useReviewStore, useConfigStore)

**Type Safety Bridge:**
- Purpose: Ensure frontend/backend type consistency and eliminate manual serialization
- Location: `src/types/bindings.ts` (auto-generated), `src-tauri/src/models/`
- Contains: Auto-generated TypeScript types from Rust structs with `#[derive(TS)]`
- Process: Rust models with ts-rs macro → TypeScript types on build

**IPC Communication Layer:**
- Purpose: Frontend-to-backend command routing via Tauri
- Location: `src/lib/tauri-safe.ts`, `src/lib/tauri-mock.ts`
- Contains:
  - `tauri-safe.ts`: Production-safe wrapper with comprehensive logging (all invocations logged to console with [Tauri] prefix)
  - `tauri-mock.ts`: Development-time mock responses for browser-only testing (tree-shaken from production build via `import.meta.env.DEV`)
  - `@tauri-apps/api/core.invoke()`: Raw Tauri IPC mechanism
- Depends on: Tauri 2 runtime
- Used by: All components and stores for backend operations

**Backend IPC Handler Layer:**
- Purpose: Route and dispatch frontend commands to business logic
- Location: `src-tauri/src/ipc/handlers.rs`, `src-tauri/src/ipc/ssh_handlers.rs`
- Contains: 50+ `#[tauri::command]` functions (registered in main.rs)
  - Project operations: get_projects, get_or_create_project, create_project
  - Task operations: get_tasks, create_task, update_task
  - Execution: spawn_agent_execution, pause/resume/retry/cancel execution
  - Review: get_diff_for_review, save_task_review, request_changes, approve_task_and_merge
  - SSH: SSH connection management, password persistence
  - Settings: get_settings, save_settings, project/task configuration
  - Worktree pool: lease_worktree, return_worktree, cleanup_worktree, recover_dirty_worktrees
- Depends on: Database (AppState), process spawner, git operations, SSH client
- Used by: Frontend via Tauri invoke

**Database Layer:**
- Purpose: Persistent storage with schema versioning and foreign key integrity
- Location: `src-tauri/src/db/`
- Contains:
  - `connection.rs`: SQLite initialization (creates app data directory, enables foreign keys, initializes schema)
  - `schema.rs`: SQL schema definition with version tracking (SCHEMA_VERSION = 8)
  - `settings.rs`: Settings persistence (load/save operations)
  - `execution_logs.rs`: Execution log CRUD operations
- Depends on: rusqlite (SQLite Rust driver), tokio runtime
- Used by: IPC handlers and business logic

**Process Execution Layer:**
- Purpose: Run agent CLI commands in isolated subprocess environments
- Location: `src-tauri/src/process/`
- Contains:
  - `spawner.rs`: Local subprocess spawning (non-PTY)
  - `pty.rs`: Local pseudo-terminal session management (spawner.rs spawns, pty.rs manages PTY lifecycle)
  - `remote.rs`: Remote SSH process execution and PTY streaming
- Execution flow: Task → Execution Config → (local PTY or remote SSH) → ProcessOutput
- Depends on: PTY library, SSH client, tokio runtime
- Used by: IPC handlers (spawn_agent_execution dispatcher)

**Git Operations Layer:**
- Purpose: Worktree management and repository operations
- Location: `src-tauri/src/git/`
- Contains: Worktree creation, branch management, diff extraction, git commands
- Depends on: git2 library or shell execution
- Used by: Process execution layer and IPC handlers

**SSH/Remote Execution Layer:**
- Purpose: Secure shell connectivity and remote command execution
- Location: `src-tauri/src/ssh/`, `src-tauri/src/websocket/`
- Contains:
  - `ssh/client.rs`: SSH connection pooling and command execution
  - `ssh/session.rs`: SSH session state management (connected, disconnected, password pending)
  - `ssh/password_manager.rs`: Credential persistence (platform-specific keychain integration)
  - `websocket/streaming.rs`: Real-time terminal output streaming over WebSocket
- Depends on: ssh2 crate, system keychain/credential manager, tokio runtime
- Used by: Process execution layer for remote task execution

**AppState (Global Application State):**
- Purpose: Thread-safe container for shared mutable state across Tauri command handlers
- Location: `src-tauri/src/db/connection.rs`
- Contains:
  - `db: Mutex<Connection>`: SQLite connection (locked per operation)
  - `pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<PtySession>>>`: Active PTY sessions mapped by task ID
  - `ssh_sessions: Arc<tokio::sync::Mutex<HashMap<i64, RemoteSshSession>>>`: Active SSH sessions mapped by project ID (lazy connection on demand)
- Thread-safety: All mutable state wrapped in Mutex/tokio::sync::Mutex with proper locking discipline
- Lifetime: Single AppState instance created in Tauri setup (fn setup), managed by Tauri framework

## Data Flow

**Project Selection Flow:**

1. App.tsx mounts → loads settings via `get_settings` IPC
2. If no project_path in settings → show ProjectPicker (two-phase startup)
3. ProjectPicker displays:
   - Local: Browse filesystem with FilePicker
   - SSH: List saved SSH connections, connect and browse remote filesystem
   - Recent: Quick access to 5 most recent projects
4. User selects project path → `get_or_create_project` IPC
   - Backend: Query projects table by path
   - If exists: Return existing Project record
   - If new: Create project record, insert into database, return
5. Frontend: Save new project_path to settings via `save_settings`
6. Frontend: Load tasks for selected project via `get_tasks`
7. Frontend: Dispatch to boardStore.loadTasks() → Zustand state updated
8. Main UI becomes visible (AppHeader, KanbanBoard, modals)

**Task Execution Flow:**

1. User drags task card to "InProgress" column
2. KanbanBoard.handleDragEnd() → updateTaskStatus("InProgress") in boardStore
3. (Alternatively) User clicks "Execute" button on task → executeTask action
4. executeTask invokes `spawn_agent_execution` IPC with (project_id, task_id, repo_path)
5. IPC handler `spawn_agent_execution`:
   - Fetch task, project, worktree from database
   - Determine execution path: Local or Remote
   - Local: spawn_agent_cli_pty() → ProcessOutput
   - Remote: spawn_remote_agent_execution() via SSH → RemoteProcessHandle + ProcessOutput
   - Create execution_log record in database with status=running
   - Return execution_log_id to frontend
6. Frontend: Update task status to "InProgress" in boardStore
7. Optional: User opens terminal → attach_terminal listener streams execution output in real-time
8. Execution completes → backend updates execution_log (status=completed/failed, filled completion_at)
9. Frontend polls or listens for status changes, renders task completion badges

**Code Review & Merge Flow:**

1. User clicks "Review" button on completed task
2. ReviewModal opens → calls `get_diff_for_review` IPC
3. Backend: Extract diff from worktree branch vs main
4. Frontend: Parse diff with diffParser.ts → render side-by-side viewer
5. User approves → `approve_task_and_merge` IPC
   - Backend: Merge worktree branch to main via git
   - Update task status to "Done"
   - Return merge outcome (success/conflict)
6. User requests changes → `request_changes` IPC with feedback comments
   - Backend: Save review feedback to task_reviews table
   - Save per-file comments to review_comments table
   - Task remains in "Review" status
   - Create new execution_log entry for retry

**State Management:**

- Frontend task state: Zustand store with Immer (mutations look synchronous, applied immutably)
- Backend task state: SQLite tasks table (single source of truth)
- Session state: AppState (PTY and SSH sessions persist across IPC calls within same Tauri process)
- No bidirectional sync: Frontend is authoritative for UI state, backend is authoritative for persistence
- Polling pattern: Components fetch state on demand (no real-time subscriptions except terminal output stream)

## Key Abstractions

**Project:**
- Purpose: Represents a Git repository and its associated configuration
- Examples: `src-tauri/src/models/project.rs` (Rust struct with TS derive), `src/types/bindings.ts` (auto-generated)
- Pattern: Can be local filesystem path or remote SSH path with saved credentials
- Fields: id (PK), name, path, created_at, is_remote, ssh_config (Option<SshConfig>)

**Task:**
- Purpose: Unit of work with acceptance criteria and execution metadata
- Examples: `src-tauri/src/models/task.rs`
- Pattern: Status is enum (Backlog, Ready, InProgress, Review, Merging, Failed, Done)
- Fields: id, project_id (FK), name, description, acceptance_criteria, status, skills (JSON), model_override, mcp_allowlist, skills_override, created_at, updated_at
- Linked to: ExecutionLog (1:N), Worktree (1:1 for active execution)

**ExecutionLog:**
- Purpose: Track individual command executions with output and status
- Examples: `src-tauri/src/models/execution_log.rs`
- Pattern: One per execution attempt (retry creates new log)
- Fields: id, task_id (FK), output (command stdout), terminal_output (PTY recording), status (running/completed/failed), started_at, completed_at
- Supports: Streaming output via attach_terminal, pause/resume state tracking

**Worktree:**
- Purpose: Isolated git worktree branch for task execution
- Examples: `src-tauri/src/models/worktree.rs`
- Pattern: Pooling strategy (initialize_worktree_pool creates N worktrees, lease_worktree assigns to task, return_worktree releases)
- Fields: id, project_id (FK), branch_name, path, status (available/leased/dirty), leased_at, returned_at, created_at
- Lifecycle: created → available → leased → returned → available (or dirty if crash cleanup needed)

**GitConnection:**
- Purpose: Abstraction for local vs. remote git access
- Examples: `src-tauri/src/models/connection.rs`
- Pattern: Enum with two variants (Local or Remote with SSH details)
- Used by: Process spawner to route execution to local PTY or remote SSH

**ProcessOutput:**
- Purpose: Unified result type for local and remote execution
- Examples: `src-tauri/src/process/mod.rs` (ProcessOutput struct and RemoteProcessHandle)
- Pattern: Contains stdout, stderr, exit_code, success flag, optional remote_pid
- Used by: IPC handlers to return execution results to frontend

**AppSettings:**
- Purpose: User-configurable application-wide settings
- Examples: `src-tauri/src/models/settings.rs`
- Pattern: Stored in SQLite settings table (key-value store)
- Fields: project_path (current), recent_projects (Vec<String>), model_default, mcp_allowlist, skills_default, theme_preference, updated_at
- Lifecycle: Loaded at startup via `get_settings`, modified by user, persisted via `save_settings`

**RemoteSshSession:**
- Purpose: Lazy SSH session holder for a remote project
- Examples: `src-tauri/src/ssh/session.rs`
- Pattern: Session created on demand (lazy connection), cached in AppState.ssh_sessions
- Connected on first use: password/key auth deferred until actual command needed
- Supports: Password prompting (PasswordModal shows when backend returns credential challenge)

## Entry Points

**Frontend Entry:**
- Location: `src/main.tsx`
- Triggers: Browser loads HTML, Vite injects React app
- Responsibilities: Detect system theme synchronously (prevent FOUC), render App.tsx

**App Root Component:**
- Location: `src/App.tsx`
- Triggers: React mounts root component
- Responsibilities: Load settings, determine project selection vs. main UI flow, render appropriate page (ProjectPicker, KanbanBoard, SettingsPage, etc.)

**Backend Entry:**
- Location: `src-tauri/src/main.rs`
- Triggers: Tauri runtime starts
- Responsibilities:
  - Call setup() hook → init_db → schema initialization
  - Create AppState (database connection + session maps)
  - Register all IPC command handlers
  - Load SSH sessions from database for remote projects (lazy, no connections yet)
  - Start Tauri event loop

**Database Initialization:**
- Location: `src-tauri/src/db/connection.rs::init_db()`
- Triggers: Tauri setup hook
- Responsibilities: Create app data directory, open SQLite connection, enable foreign keys, call initialize_schema

**Schema Setup:**
- Location: `src-tauri/src/db/schema.rs::initialize_schema()`
- Triggers: First database connection after version bump
- Responsibilities: Check PRAGMA user_version, apply migrations if needed (v1 → v8), ensure all tables exist

## Error Handling

**Strategy:** Errors are mapped to String for Tauri IPC serialization, logged to browser console for debugging.

**Patterns:**

1. **Rust Result<T, String>:**
   - IPC handlers return Result<T, String> (Tauri serializable)
   - Database errors: `.map_err(|e| e.to_string())?`
   - Example from handlers.rs: `conn.query_row(...).map_err(|e| e.to_string())?`

2. **Frontend Error Handling:**
   - Try-catch blocks around safeInvoke() calls
   - Errors logged to console with [Tauri] prefix (visible in DevTools)
   - User-facing errors shown via toast notifications (Sonner library)
   - Example: `const tasks = await safeInvoke<Task[]>("get_tasks", { projectId })`

3. **Database Constraints:**
   - Foreign key constraints enforced (PRAGMA foreign_keys = ON)
   - Cascade delete: projects → tasks, worktrees, execution_logs (on project delete)
   - Unique constraints: projects(path), task_reviews(task_id)

4. **Mock Fallback (Dev Mode):**
   - tauri-mock.ts detects Tauri availability via `typeof (window as any).__TAURI__`
   - If Tauri unavailable and `import.meta.env.DEV === true`: return mock data
   - If Tauri unavailable and production build: errors thrown (prevented by tree-shaking)

## Cross-Cutting Concerns

**Logging:**
- Frontend: `console.log()` with [DEBUG] or [Tauri] prefixes, visible in DevTools
- Backend: `println!()` sent to stderr, captured by Tauri launcher
- Key events logged: IPC invocations (arguments and results), database operations, process spawning

**Validation:**
- Frontend: Basic form validation in TaskModal, TaskForm (required fields)
- Backend: Database constraints (NOT NULL, UNIQUE, FOREIGN KEY)
- No JSON schema validation (frontend types derived from Rust, implicit safety)

**Authentication:**
- SSH: Password or key-based auth (password_manager stores credentials in system keychain)
- Project access: File system permissions for local, SSH credentials for remote
- GitHub/Jira: API tokens stored in project settings (not persisted in app settings)

**Type Safety:**
- Rust models with `#[derive(TS, Serialize, Deserialize)]`
- Auto-generated TypeScript bindings in `src/types/bindings.ts`
- Frontend components import from bindings.ts, ensuring consistency
- No manual serialization/deserialization (error-prone and removed in ts-rs pattern)

**Theme & Styling:**
- CSS variables in `src/index.css` (light/dark color tokens)
- ThemeProvider detects system theme and injects class on document root
- Tailwind 4.1 with `@tailwindcss/vite` plugin for build-time CSS
- shadcn/ui components styled with Tailwind + CSS variables

**Concurrency:**
- Frontend: Single-threaded (React event loop), async/await for IPC
- Backend: Tokio runtime for async operations (process spawning, SSH sessions)
- Mutex/Arc patterns: AppState fields wrapped for thread-safe access across Tauri command handlers
- No race conditions: Database locking via rusqlite (serialized access), Mutex guards for session maps

---

*Architecture analysis: 2026-02-14*
