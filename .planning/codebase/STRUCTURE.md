# Codebase Structure

**Analysis Date:** 2026-02-14

## Directory Layout

```
gsd-demo/
├── src/                           # Frontend React application (TypeScript)
│   ├── components/                # React components
│   │   ├── ui/                    # shadcn/ui primitive components
│   │   ├── AppHeader.tsx          # Top navigation bar with project/view switcher
│   │   ├── KanbanBoard.tsx        # Main task board layout
│   │   ├── TaskCard.tsx           # Individual task card component
│   │   ├── KanbanColumn.tsx       # Single Kanban column container
│   │   ├── ProjectPicker.tsx      # Project selection modal (main entry UI)
│   │   ├── TaskModal.tsx          # New task creation dialog
│   │   ├── TaskDetail.tsx         # Task detail panel (side drawer)
│   │   ├── ExecutionTerminal.tsx  # Live terminal output viewer
│   │   ├── ReviewModal.tsx        # Code review approval interface
│   │   ├── SettingsPage.tsx       # Application settings page
│   │   ├── AgentMonitor.tsx       # Agent execution monitoring
│   │   ├── WorktreeManager.tsx    # Worktree pool status and management
│   │   ├── DiffViewer.tsx         # Side-by-side diff viewer
│   │   └── [other components]     # Import forms, connection managers, etc.
│   ├── store/                     # Zustand state management (Immer middleware)
│   │   ├── boardStore.ts          # Task state, execution lifecycle
│   │   ├── reviewStore.ts         # Code review state
│   │   └── configStore.ts         # Application configuration state
│   ├── providers/                 # Context providers
│   │   └── ThemeProvider.tsx      # Dark/light theme management
│   ├── hooks/                     # Custom React hooks
│   │   └── useRecentProjects.ts   # Load and manage recent projects
│   ├── lib/                       # Utility functions and wrappers
│   │   ├── tauri-safe.ts          # Production-safe IPC wrapper with logging
│   │   ├── tauri-mock.ts          # Development mock responses (tree-shaken in prod)
│   │   ├── path-utils.ts          # Filesystem path utilities
│   │   └── utils.ts               # General utilities
│   ├── types/                     # TypeScript type definitions
│   │   ├── bindings.ts            # Auto-generated types from Rust (via ts-rs)
│   │   ├── review.ts              # Review-specific types
│   │   └── [generated types]
│   ├── utils/                     # Utility modules
│   │   ├── diffParser.ts          # Parse git diff output to structured format
│   │   └── [other utils]
│   ├── App.tsx                    # Root app component (project selection, page routing)
│   ├── App.css                    # App-level styles
│   ├── index.css                  # Global styles, CSS variables, font loading
│   └── main.tsx                   # React entry point (renders App.tsx)
│
├── src-tauri/                     # Rust backend (Tauri application)
│   ├── src/
│   │   ├── main.rs                # Tauri app entry point, IPC handler registration
│   │   ├── lib.rs                 # Library root, re-exports public modules
│   │   ├── db/                    # Database layer
│   │   │   ├── connection.rs      # SQLite init, AppState definition
│   │   │   ├── schema.rs          # SQL schema and migrations
│   │   │   ├── settings.rs        # Settings persistence (load/save)
│   │   │   ├── execution_logs.rs  # Execution log CRUD operations
│   │   │   └── mod.rs             # Module exports
│   │   ├── models/                # Domain models with TS derives
│   │   │   ├── task.rs            # Task struct, TaskStatus enum
│   │   │   ├── project.rs         # Project struct
│   │   │   ├── worktree.rs        # Worktree struct, WorktreeStatus enum
│   │   │   ├── execution_log.rs   # ExecutionLog struct, ExecutionStatus enum
│   │   │   ├── settings.rs        # AppSettings struct
│   │   │   ├── connection.rs      # Connection status and SSH config
│   │   │   ├── review.rs          # ReviewFeedback, ReviewDecision types
│   │   │   ├── sync.rs            # GitHub/Jira sync result types
│   │   │   ├── merge_outcome.rs   # Git merge result type
│   │   │   └── mod.rs             # Module exports
│   │   ├── ipc/                   # IPC command handlers
│   │   │   ├── handlers.rs        # Main IPC handlers (50+ tauri::command functions)
│   │   │   ├── ssh_handlers.rs    # SSH connection management handlers
│   │   │   └── mod.rs             # Module exports
│   │   ├── process/               # Process execution management
│   │   │   ├── spawner.rs         # Local subprocess spawning (non-PTY)
│   │   │   ├── pty.rs             # Local PTY session management
│   │   │   ├── remote.rs          # Remote SSH process execution
│   │   │   └── mod.rs             # Module exports (dispatcher)
│   │   ├── git/                   # Git operations
│   │   │   ├── remote.rs          # Remote git operations via SSH
│   │   │   └── mod.rs             # Git module exports
│   │   ├── ssh/                   # SSH client and connection management
│   │   │   ├── client.rs          # SSH client connection logic
│   │   │   ├── session.rs         # SSH session state (lazy connection)
│   │   │   ├── password_manager.rs # Credential persistence (keychain)
│   │   │   ├── error.rs           # SSH-specific error types
│   │   │   └── mod.rs             # Module exports
│   │   ├── websocket/             # Real-time terminal streaming
│   │   │   ├── streaming.rs       # WebSocket streaming for terminal output
│   │   │   └── mod.rs             # Module exports
│   │   ├── error.rs               # Custom error types (AppError enum)
│   │   └── [other modules]
│   ├── Cargo.toml                 # Rust dependencies, ts-rs export config
│   ├── tauri.conf.json            # Tauri app configuration
│   └── target/                    # Compiled Rust artifacts (build output)
│
├── tests/                         # E2E test suite
│   └── e2e/
│       ├── ProjectPicker.spec.ts  # ProjectPicker visual regression tests
│       ├── hover-states.spec.ts   # UI interaction tests
│       └── [other E2E tests]
│
├── dist/                          # Production build output (React frontend)
├── vite.config.ts                 # Vite bundler configuration
├── tsconfig.json                  # TypeScript configuration (strict mode)
├── tauri.conf.json                # Tauri app configuration (window size, bundle)
├── playwright.config.ts           # E2E test runner configuration
├── components.json                # shadcn/ui component configuration
├── package.json                   # npm dependencies (pnpm lockfile: pnpm-lock.yaml)
└── .planning/                     # GSD project planning documents
    ├── PROJECT.md                 # Current milestone goals and requirements
    ├── ROADMAP.md                 # Phase breakdown and execution sequence
    ├── STATE.md                   # Phase tracking and velocity metrics
    └── codebase/                  # This codebase analysis
        ├── ARCHITECTURE.md        # Architecture patterns and data flow
        └── STRUCTURE.md           # Directory layout and file organization (you are here)
```

## Directory Purposes

**`src/`**
- Purpose: React frontend application source code
- Contains: TypeScript/React components, state management, utilities, styles
- Key files: App.tsx (root), main.tsx (entry), index.css (global styles)

**`src/components/`**
- Purpose: React component library for UI rendering
- Contains: Page components, feature components (modals, forms), shadcn/ui primitives
- Naming: PascalCase filenames (e.g., KanbanBoard.tsx, TaskCard.tsx)
- Pattern: Each component is a separate file, optionally with co-located CSS modules

**`src/components/ui/`**
- Purpose: Shared UI primitive components from shadcn/ui (copy-paste library)
- Contains: Button, Dialog, Input, Card, Tabs, Badge, etc.
- Pattern: One component per file, auto-imported by feature components
- Styling: Tailwind CSS with theme-aware CSS variables

**`src/store/`**
- Purpose: Zustand state management with Immer middleware
- Contains: Three stores (boardStore, reviewStore, configStore)
- Pattern: Each store exports a custom hook (useBoardStore, useReviewStore, useConfigStore)
- Immer pattern: Direct mutations are proxied to immutable updates

**`src/providers/`**
- Purpose: React Context providers for global state
- Contains: ThemeProvider for light/dark/system theme management
- Pattern: Wraps entire App.tsx in ThemeProvider component
- Functionality: System theme detection, CSS variable injection, persistence

**`src/hooks/`**
- Purpose: Custom React hooks for reusable component logic
- Contains: useRecentProjects (fetches and caches recent projects)
- Pattern: Each hook is a separate file named useXxx.ts
- Usage: Imported by components that need the hook functionality

**`src/lib/`**
- Purpose: Core library functions and wrappers
- Contains:
  - `tauri-safe.ts`: IPC wrapper with logging (production-safe)
  - `tauri-mock.ts`: Development mock responses (tree-shaken from production)
  - `path-utils.ts`: Filesystem path helpers
  - `utils.ts`: General-purpose utilities
- Pattern: Pure functions, no side effects except logging

**`src/types/`**
- Purpose: TypeScript type definitions
- Contains:
  - `bindings.ts`: Auto-generated types from Rust models (via ts-rs on build)
  - `review.ts`: Review-specific types
- Pattern: bindings.ts is generated, never manually edited; review.ts is hand-written
- Usage: Imported by components and stores for type safety

**`src/utils/`**
- Purpose: Utility modules for specific domains
- Contains:
  - `diffParser.ts`: Parse git diff output to structured format (used by ReviewModal)
  - Other utilities as needed
- Pattern: Each utility is a separate file with focused responsibility

**`src-tauri/src/`**
- Purpose: Rust backend source code for Tauri desktop app
- Contains: IPC handlers, database, process execution, SSH management
- Compilation: Outputs to src-tauri/target/debug or target/release

**`src-tauri/src/db/`**
- Purpose: Database layer (SQLite with schema versioning)
- Contains:
  - `connection.rs`: Database initialization and AppState
  - `schema.rs`: SQL schema definition with version tracking
  - `settings.rs`: Settings load/save operations
  - `execution_logs.rs`: ExecutionLog CRUD operations
- Pattern: Each module handles one database concern
- Schema version: SCHEMA_VERSION = 8 (migrations applied on startup)

**`src-tauri/src/models/`**
- Purpose: Domain models with TypeScript code generation
- Contains: Task, Project, Worktree, ExecutionLog, AppSettings, SshConfig, etc.
- Pattern: Each model is a separate file, struct with `#[derive(TS, Serialize, Deserialize)]`
- Generation: `cargo build` triggers ts-rs macro → outputs to `src/types/bindings.ts`

**`src-tauri/src/ipc/`**
- Purpose: Tauri IPC command handlers (frontend ↔ backend communication)
- Contains:
  - `handlers.rs`: 50+ `#[tauri::command]` functions for all business logic
  - `ssh_handlers.rs`: SSH connection management handlers
- Pattern: Each handler is a public function marked with `#[tauri::command]` macro
- Registration: All handlers listed in main.rs invoke_handler![] macro

**`src-tauri/src/process/`**
- Purpose: Subprocess and process execution (local PTY and remote SSH)
- Contains:
  - `spawner.rs`: Local subprocess spawning without PTY
  - `pty.rs`: Local pseudo-terminal session management
  - `remote.rs`: Remote SSH process execution
  - `mod.rs`: Dispatcher that routes to local or remote based on GitConnection
- Pattern: Async functions using tokio runtime
- Execution: spawn_agent_execution dispatcher routes to appropriate executor

**`src-tauri/src/ssh/`**
- Purpose: SSH client and connection state management
- Contains:
  - `client.rs`: SSH connection pooling and command execution
  - `session.rs`: SSH session state (lazy connection pattern)
  - `password_manager.rs`: Credential storage (system keychain)
  - `error.rs`: SSH-specific error types
- Pattern: RemoteSshSession held in AppState, lazy connection on first use
- Credentials: Prompted via PasswordModal in frontend, stored in system keychain

**`src-tauri/src/git/`**
- Purpose: Git repository operations
- Contains: Worktree creation, branch management, diff extraction
- Pattern: Git operations exposed as functions called by IPC handlers
- Implementation: Uses git2 crate or shell execution

**`src-tauri/src/websocket/`**
- Purpose: Real-time terminal output streaming to frontend
- Contains: WebSocket streaming logic for live execution output
- Pattern: Async streaming using tokio runtime
- Usage: ExecutionTerminal component receives real-time output

**`tests/e2e/`**
- Purpose: End-to-end tests with Playwright (UI regression and interaction testing)
- Contains:
  - `ProjectPicker.spec.ts`: ProjectPicker visual regression tests
  - `hover-states.spec.ts`: UI interaction and hover state tests
  - Other E2E test files
- Runs against: `http://localhost:5173` (dev server)
- Configuration: `playwright.config.ts`

**`.planning/codebase/`**
- Purpose: Codebase analysis documentation (this directory)
- Contains: ARCHITECTURE.md, STRUCTURE.md (these files)
- Generated by: `/gsd:map-codebase` orchestrator command
- Consumed by: `/gsd:plan-phase`, `/gsd:execute-phase` orchestrator commands

## Key File Locations

**Entry Points:**
- `src/main.tsx`: React entry point (renders App.tsx into DOM)
- `src-tauri/src/main.rs`: Tauri app entry point (setup hook, handler registration)
- `src/App.tsx`: Root app component (project selection flow, page routing)

**Configuration:**
- `vite.config.ts`: Vite bundler config (port 5173, HMR, Tauri plugin)
- `tsconfig.json`: TypeScript compiler options (strict mode enabled)
- `tauri.conf.json`: Tauri app configuration (window size, bundle settings)
- `playwright.config.ts`: E2E test configuration (baseURL: http://localhost:5173)
- `components.json`: shadcn/ui component configuration (paths, Tailwind)
- `Cargo.toml`: Rust dependencies, ts-rs export config (export_dir = "../src/types")

**Core Logic:**
- `src/store/boardStore.ts`: Task execution lifecycle (spawn, pause, resume, abort)
- `src-tauri/src/ipc/handlers.rs`: All business logic IPC commands (50+ handlers)
- `src-tauri/src/db/connection.rs`: Database and AppState initialization
- `src-tauri/src/db/schema.rs`: SQLite schema definition

**State Management:**
- `src/store/boardStore.ts`: Task CRUD and execution state (Zustand + Immer)
- `src/store/reviewStore.ts`: Code review state
- `src/store/configStore.ts`: Configuration state
- `src-tauri/src/db/connection.rs`: AppState (database, PTY sessions, SSH sessions)

**Testing:**
- `tests/e2e/ProjectPicker.spec.ts`: ProjectPicker regression tests
- `tests/e2e/hover-states.spec.ts`: UI interaction tests
- `playwright.config.ts`: Playwright configuration

## Naming Conventions

**Files:**
- React components: PascalCase (KanbanBoard.tsx, TaskCard.tsx, ProjectPicker.tsx)
- TypeScript utilities: camelCase (tauri-safe.ts, path-utils.ts, diffParser.ts)
- Rust modules: snake_case (handlers.rs, connection.rs, execution_logs.rs)
- Test files: DescriptionInPascalCase.spec.ts (ProjectPicker.spec.ts)
- CSS files: kebab-case or PascalCase matching component (App.css, TaskCard.module.css)

**Directories:**
- React components: lowercase plural (components, hooks, store, providers)
- Rust modules: lowercase plural (db, models, ipc, process, ssh)
- UI components: lowercase (ui/)
- Test directories: lowercase (e2e)
- Planning directories: lowercase (phases, codebase)

**TypeScript/React:**
- Functions: camelCase (getStatusDotColor, formatElapsedTime, executeTask)
- Components: PascalCase (KanbanBoard, ProjectPicker, TaskCard)
- Types/Interfaces: PascalCase (Task, Project, BoardState, ThemeContextValue)
- Constants: UPPER_SNAKE_CASE (COLUMN_STATUSES, SCHEMA_VERSION)
- Hooks: useXxx (useBoardStore, useRecentProjects)

**Rust:**
- Functions: snake_case (spawn_agent_execution, get_or_create_project)
- Structs/Enums: PascalCase (Task, TaskStatus, ExecutionLog, ExecutionStatus)
- Constants: UPPER_SNAKE_CASE (SCHEMA_VERSION)
- Modules: snake_case (handlers, connection, execution_logs)

## Where to Add New Code

**New Feature (e.g., Dashboard Widget):**
- Component: `src/components/DashboardWidget.tsx`
- State: Add actions to `src/store/boardStore.ts` if needed
- API: Add handler to `src-tauri/src/ipc/handlers.rs`
- Database: Add columns/table to `src-tauri/src/db/schema.rs` if needed
- Types: Define Rust struct in `src-tauri/src/models/` with `#[derive(TS)]`

**New Component/Module:**
- Location: `src/components/NewFeature.tsx` (or directory if large)
- Styling: Component-specific CSS in `src/components/NewFeature.module.css`
- Hooks: Extract reusable logic to `src/hooks/useNewFeature.ts`
- Types: Import from `src/types/bindings.ts`

**Utilities:**
- Pure functions: `src/lib/` (e.g., tauri-safe.ts)
- Domain-specific: `src/utils/` (e.g., diffParser.ts)
- Path manipulation: `src/lib/path-utils.ts`

**Backend Handlers:**
- IPC commands: `src-tauri/src/ipc/handlers.rs` (add `#[tauri::command]`)
- SSH-specific: `src-tauri/src/ipc/ssh_handlers.rs`
- Register handler: Add to main.rs invoke_handler![] list

**New Database Entity:**
- Model: `src-tauri/src/models/my_entity.rs` with `#[derive(TS, Serialize, Deserialize)]`
- Schema: Update `src-tauri/src/db/schema.rs` (increment SCHEMA_VERSION, add migration)
- CRUD: Add functions to `src-tauri/src/db/` (or inline in handlers.rs for simple ops)
- Types: Run `cargo build` to auto-generate TypeScript types in `src/types/bindings.ts`

**Tests:**
- E2E tests: `tests/e2e/FeatureName.spec.ts`
- Rust unit tests: Co-located with source (e.g., `src-tauri/src/models/task.rs` can have #[cfg(test)] mod tests)
- Configuration: Edit `playwright.config.ts` if needed for new test patterns

**Styling:**
- Global styles: `src/index.css` (CSS variables, font loading, base styles)
- Component styles: Component-specific CSS or Tailwind className props
- Theme variables: Define in `src/index.css` (light and dark color tokens)
- Fonts: Load in `src/index.css` (@import or @font-face)

## Special Directories

**`src/types/bindings.ts`:**
- Purpose: Auto-generated TypeScript types from Rust models
- Generated: On `cargo build` (ts-rs macro processes `#[derive(TS)]` structs)
- Never manually edit: Regenerated on every Rust build
- Configuration: Cargo.toml section [package.metadata.ts-rs]
- Export directory: `export_dir = "../src/types"`

**`dist/`:**
- Purpose: Production build output (Vite bundler)
- Generated: On `pnpm build`
- Never commit: Add to .gitignore
- Contents: Optimized JavaScript, CSS, HTML

**`src-tauri/target/`:**
- Purpose: Rust compilation artifacts
- Generated: On `cargo build`
- Never commit: Add to .gitignore
- Subdirectories: debug/ (dev), release/ (production)

**`.planning/phases/`:**
- Purpose: Detailed implementation plans for each GSD phase
- Format: Markdown documents with task breakdown, verification criteria
- Pattern: Numbered phases (01-setup, 02-core-ui, etc.)
- Generated by: GSD orchestrator

---

*Structure analysis: 2026-02-14*
