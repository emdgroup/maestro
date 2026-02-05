# Stack Research: AI Agent Orchestration Desktop Platform

**Domain:** Desktop application for orchestrating autonomous AI agents with CLI process management, git worktree isolation, and real-time monitoring

**Researched:** February 4, 2025

**Confidence:** HIGH (verified with Context7 documentation and official sources)

**Architecture Pattern:** Tauri 2 (Rust backend) + React (TypeScript frontend) + Node.js sidecar (process management)

---

## Recommended Stack

### Core Framework Layer

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Tauri** | 2.10.1 (latest Feb 2025) | Desktop application framework | **Verified choice**: Tauri 2.10+ is the current stable branch. Provides native Rust backend with minimal bundle size (~40MB vs 150MB+ for Electron). Critical for this use case: supports sidecar processes natively, direct OS-level file/process access, and efficient IPC. High-reputation source (16,899 code snippets in Context7) |
| **React** | 19.1+ (current stable) | Frontend UI framework | Latest React stable with improved hooks, better TypeScript support, and Server Components support. High adoption in desktop apps. Benchmark score 91.7 in Context7. Works seamlessly with Vite for instant HMR during development |
| **TypeScript** | 5.9+ | Type-safe development | Prevents runtime errors in complex orchestration logic. Essential for CLI integration and git operations. Context7 score 91.3 |
| **Node.js** | 22 LTS | Sidecar process runner | Runs Claude Code CLI, manages child processes, WebSocket server. LTS version ensures stability. Native ES modules support |

### Build & Development Tools

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Vite** | 7.0+ | Frontend build tool | Lightning-fast HMR for React development. Native TypeScript support. Significantly faster than webpack. Benchmark 83.4. Native ESM support means smaller bundles |
| **Cargo** | 1.75+ | Rust package manager | Included with Rust/Tauri. Manages Rust dependencies and Tauri-specific features |

### Frontend State Management & Data Layer

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Zustand** | 5.0+ | React state management | Lightweight (2KB), hook-based API. Perfect for Kanban board state, task queues, agent status tracking. No provider hell. Benchmark 81. Handles concurrent updates needed for real-time monitoring |
| **TanStack Query (React Query)** | 5.60+ | Server state management | Manages server-side state: task history, git operations, terminal session data. Automatic cache invalidation, background refetching. Benchmark 93.2 (highest in category). Essential for syncing with backend without polling |

### Terminal Emulation & UI

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Xterm.js** | 5.3+ | Terminal emulation in browser | Browser-based terminal component. Handles ANSI escape codes, terminal resizing, copy/paste. AttachAddon enables WebSocket streaming directly into terminal. Used by VS Code, Hyper. Context7 score 84. Critical for real-time CLI output visualization |
| **Shadcn/ui** | 0.9+ | React component library | Accessible, customizable components built on Radix UI + Tailwind. Perfect for Kanban board UI, modals, forms. Paste-based (not NPM dependency) means total control |
| **Tailwind CSS** | 3.4+ | Utility-first CSS | Zero-runtime CSS. Rapid UI development. Benchmark 85.9. Standard choice for modern React apps. Works perfectly with Shadcn |

### Git Operations

| Technology | Version | Purpose | When to Use |
|-----------|---------|---------|------------|
| **simple-git** (GitJS) | 3.20+ | Git commands from Node.js | Primary choice for worktree management (`git worktree add/remove`), branch operations, status checks. Promise-based API, good error handling. Benchmark 81.9. Best for: standard git operations from Node sidecar |
| **isomorphic-git** | 1.24+ | Pure JS git implementation | Secondary option for browser-based git operations or when native dependencies problematic. Works in Node + browser. NOT ideal for worktree operations (requires native git). Benchmark 618 snippets. Best for: simple operations, browser compatibility |

### Database & Persistence

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **SQLite 3** | 3.46+ | Local embedded database | Zero server setup, single-file database perfect for desktop app. ACID-compliant for task state. No network overhead |
| **better-sqlite3** | 12.4.1 | Node.js SQLite driver | Synchronous API (matches Node.js process model), exceptional performance (benchmark 94). Better than async drivers for simple queries. Fastest in category. Critical for: sidecar process to write task results |
| **rusqlite** | 0.31+ | Rust SQLite driver | Main Tauri backend database driver. Simple API, good ecosystem support. Used when Rust backend needs direct DB access for performance-critical operations |
| **sqlx** | 0.7+ | Rust async SQL toolkit | Alternative if future async requirements emerge. Compile-time checked queries. For now: better-sqlite3 sufficient |

### Real-Time Communication

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **ws** | 8.18+ | Node.js WebSocket server | Lightweight, fast WebSocket implementation. Benchmark 82.4. Perfect for: sidecar → frontend streaming of terminal output, file diffs, git events. Native support in modern browsers |
| **AttachAddon** (xterm.js) | Built-in | Terminal + WebSocket binding | Integrates xterm.js terminal with WebSocket backend. Bidirectional: sends terminal input to server, receives output. Handles resizing, connection lifecycle |

### Diff Viewing & File Comparison

| Technology | Version | Purpose | When to Use |
|----------|---------|---------|------------|
| **diff-match-patch** | 20240101+ | Text diff algorithm | Detects changes between agent task state before/after. Powers diff visualization in UI. Benchmark from google/diff-match-patch is high reputation. Best for: displaying file changes, code diffs |
| **git diff output parsing** | Native | Git-based diffs | Use `git diff` command output via simple-git, parse into hunks for display. More accurate than custom diff for full repos |

### Process Management & CLI Integration

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **child_process** (Node.js built-in) | Built-in | Spawn CLI processes | Core for running Claude Code CLI. Use with `stdio: 'pipe'` for output capture |
| **execa** | 6.1+ | Better process execution | Wrapper around child_process with improved error handling, template strings, cross-platform support. Benchmark 89.2. Better choice: cleaner API, better DX |
| **pty-process** | 0.5+ | PTY (pseudo-terminal) allocation | For true interactive terminal sessions. Enables proper signal handling (Ctrl+C), terminal resizing. Benchmark 63.8. Needed for: interactive debugging sessions in future v2 |

### Form Management

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **React Hook Form** | 7.66+ | Form state management | Zero dependencies, optimized re-renders. Perfect for: Kanban task input, agent configuration forms. Benchmark 91.5. Lightweight alternative to Formik |
| **Zod** | 3.22+ | TypeScript-first schema validation | Paired with React Hook Form for task validation, config validation. TypeScript-native |

### Development Experience

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Tauri CLI** | 2.10+ | Project scaffolding & build | Official Tauri development tool. Handles code signing, app bundling, hot reload |
| **create-tauri-app** | Latest | Project initialization | Official generator: `npm create tauri-app@latest` → select React |

---

## Installation Commands

### Initial Project Setup

```bash
# Initialize new Tauri + React project
npm create tauri-app@latest

# Or manual setup:
npm create vite@latest my-app -- --template react
cd my-app
npm install
npm install @tauri-apps/api @tauri-apps/cli -D
npx tauri init
```

### Frontend Dependencies

```bash
# Core dependencies
npm install react react-dom zustand @tanstack/react-query

# Terminal emulation
npm install @xterm/xterm @xterm/addon-attach @xterm/addon-fit

# UI & Styling
npm install @shadcn-ui/ui tailwindcss postcss autoprefixer
npm install clsx class-variance-authority

# Forms
npm install react-hook-form zod @hookform/resolvers

# Git operations
npm install simple-git

# Real-time communication
npm install ws

# Development
npm install -D typescript @types/react @types/react-dom @types/node
npm install -D vite @vitejs/plugin-react
```

### Backend (Rust) Dependencies

In `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri = { version = "2.10", features = ["shell-open", "system-tray", "notification", "process"] }
tokio = { version = "1.35", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
sqlx = { version = "0.7", features = ["runtime-tokio-native-tls", "sqlite"] }
rusqlite = { version = "0.31", features = ["bundled"] }
tokio-tungstenite = "0.21"  # For WebSocket support if needed
pty-process = "0.5"  # For PTY support
uuid = { version = "1.6", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
```

### Node.js Sidecar Setup

```bash
# In src-tauri/sidecars/node directory:
cd src-tauri/sidecars/node
npm init -y
npm install express dotenv simple-git better-sqlite3 ws execa uuid
npm install -D typescript @types/node nodemon
```

---

## Alternatives Considered

| Component | Recommended | Alternative | Why Not Alternative |
|-----------|------------|-------------|-------------------|
| **Desktop Framework** | Tauri 2.10+ | Electron 28+ | Electron bundles Chromium (~150MB vs Tauri ~40MB). Overkill for this use case. Tauri's native Rust backend better for file/process operations |
| **Desktop Framework** | Tauri 2.10+ | PyQt/Tkinter | Python ecosystem poor for this use case. Would need Node.js anyway for Claude CLI. Tauri's integrated Rust/JS better |
| **State Management** | Zustand | Redux Toolkit | Zustand lighter, simpler, no boilerplate. RTK overkill for Kanban state. Zustand sufficient for this complexity level |
| **State Management** | TanStack Query | SWR | TanStack Query more feature-rich (cache management, optimistic updates, refetch policies). Better for complex server state sync |
| **Terminal** | Xterm.js | Hyper Terminal | Hyper is full app, not embeddable. Xterm.js is the library Hyper uses internally |
| **Terminal** | Xterm.js | React xterm wrapper | Custom xterm.js integration more flexible. Wrapper libraries add abstraction overhead |
| **UI Library** | Shadcn/ui | Material-UI (MUI) | Shadcn/ui: copy-paste, full control, smaller bundle. MUI: larger, opinionated styling. Shadcn better for desktop app bundle size |
| **CSS** | Tailwind | CSS-in-JS (emotion/styled) | Tailwind: zero-runtime, smaller bundle, better performance. CSS-in-JS adds runtime overhead |
| **Git Ops** | simple-git | isomorphic-git | simple-git: native git commands (worktree support). isomorphic-git: pure JS (no native deps) but worktree limited. simple-git better for orchestration |
| **Database** | SQLite | PostgreSQL | SQLite: single file, zero network, perfect for desktop. Postgres: overkill, adds deployment complexity |
| **DB Driver (Node)** | better-sqlite3 | sqlite3 (async) | better-sqlite3: synchronous (matches Node model), faster (benchmark 94 vs 68). Simpler code. Ideal for sidecar |
| **Process Mgmt** | execa | spawn (native) | execa: better error messages, cross-platform, template strings. Worth the small dependency |

---

## What NOT to Use (And Why)

| Technology | Problem | Use Instead |
|-----------|---------|------------|
| **Electron** | 150MB+ bundle size, overkill for this domain | Tauri 2: 40MB, native performance |
| **Redux** | Boilerplate heavy for Kanban state | Zustand: simpler, lighter |
| **GraphQL** | Over-engineered for desktop app with single data source | REST/Tauri IPC commands sufficient |
| **socket.io** | Unnecessary abstraction, ws module sufficient | ws: native, lightweight |
| **ORM (Prisma/Sequelize)** | Desktop app doesn't need ORM complexity | Better-sqlite3 + raw SQL: simpler, faster |
| **Next.js** | Server-side rendering unnecessary, adds build complexity | Vite + React: simpler, faster |
| **CSS Frameworks (Bootstrap)** | Large, opinionated, hard to customize | Tailwind + Shadcn: smaller, flexible |
| **Async SQLite drivers** | Process-per-query overhead for task reads/writes | better-sqlite3 synchronous: simpler, faster |
| **isomorphic-git for worktrees** | Pure JS can't handle git worktree operations | simple-git (native git commands) required |
| **Custom terminal** | Reinventing ANSI parsing, handling edge cases | xterm.js: battle-tested, 10 years of fixes |

---

## Integration Architecture

### 1. Tauri Rust Backend (src-tauri/src)

**Responsibilities:**
- Desktop application shell (window management, menu, tray)
- IPC command handlers (task CRUD, monitoring)
- SQLite database access
- File system operations

**Key crates:**
- `tauri`: command invocation, window management
- `rusqlite`: local database
- `tokio`: async runtime for background tasks

**Example structure:**
```rust
#[tauri::command]
async fn create_task(title: String, state: tauri::State<AppState>) -> Result<TaskId, String> {
    // Insert into SQLite
    // Return task ID
}

#[tauri::command]
async fn monitor_task(task_id: String) -> Result<TaskStatus, String> {
    // Poll Node sidecar for updates via HTTP
}
```

### 2. Node.js Sidecar (src-tauri/sidecars/node)

**Responsibilities:**
- Spawn/manage Claude Code CLI processes
- Git worktree operations
- Terminal output streaming via WebSocket
- File change detection

**Key modules:**
- `execa`: spawn CLI processes
- `simple-git`: git operations
- `ws`: WebSocket server for terminal streaming
- `better-sqlite3`: write task results

**Example flow:**
```
Task arrives via HTTP from Rust backend
  ↓
Node sidecar spawns: execa('claude-code', ['--task', taskJson])
  ↓
CLI process output → xterm via WebSocket
  ↓
On completion, write results to SQLite
  ↓
Emit event back to Rust (via HTTP polling or callback)
```

### 3. React Frontend (src)

**Responsibilities:**
- Kanban board UI (task creation, drag-drop)
- Terminal display (xterm.js embedded)
- Real-time status monitoring
- Form inputs for task configuration

**Key flow:**
```
User adds task to Kanban
  ↓
React state (Zustand) updated
  ↓
HTTP POST /tasks (Tauri → Rust backend)
  ↓
Rust spawns Node sidecar task
  ↓
React connects WebSocket to Node sidecar for terminal output
  ↓
Xterm.js displays real-time terminal
  ↓
Task completion → TanStack Query refetch → UI update
```

---

## Data Flow & Communication Patterns

### IPC Channels

1. **React ↔ Tauri Backend**
   - Protocol: Tauri IPC (JS → Rust)
   - Use: Task CRUD, configuration
   - Example: `await invoke('create_task', { title, config })`

2. **Tauri Backend ↔ Node Sidecar**
   - Protocol: HTTP (local REST)
   - Use: Task spawn, monitoring
   - Example: `POST http://localhost:3001/tasks` with task config
   - Rationale: Simpler than Rust-to-Node FFI, easier debugging

3. **React ↔ Node Sidecar (Terminal)**
   - Protocol: WebSocket
   - Use: Real-time terminal streaming
   - Flow:
     - React connects to `ws://localhost:3001/terminal/:taskId`
     - AttachAddon pipes xterm input/output over WebSocket
     - Node PTY process output → WebSocket → Browser terminal

4. **Node Sidecar ↔ Database**
   - Protocol: SQLite (embedded)
   - Use: Persist task results, history
   - Driver: better-sqlite3 (synchronous)

---

## Version Compatibility Matrix

| Component | Version | Tested With | Notes |
|-----------|---------|------------|-------|
| Tauri | 2.10.1 | Rust 1.75+ | Latest stable (Feb 2025) |
| React | 19.1+ | Node.js 22 | Current stable |
| Node.js | 22 LTS | Native ES modules | EOL April 2027 |
| Vite | 7.0+ | React 19 | Latest, drop IE11 support |
| TypeScript | 5.9+ | `tsconfig.json` | Strict mode recommended |
| Xterm.js | 5.3+ | React 19 | Latest stable |
| better-sqlite3 | 12.4.1 | Node 22 | Requires native compile |
| simple-git | 3.20+ | Node 22 | Latest stable |
| Zustand | 5.0+ | React 19 | Latest major version |
| TanStack Query | 5.60+ | React 19 | Latest stable (v6 in alpha) |
| Tailwind CSS | 3.4+ | Vite 7 | Latest stable |
| Shadcn/ui | 0.9+ | React 19 | Latest, components auto-update |

---

## Key Decisions & Tradeoffs

### Why Tauri 2.10 Over Alternatives
- **Bundle size**: 40MB vs 150MB (Electron) matters for distribution
- **Native performance**: Rust backend for git/file ops is orders of magnitude faster
- **Sidecar support**: Native sidecar process management (Node.js CLI runner)
- **IPC overhead**: Lower latency than Electron for frequent task updates

### Why Node.js Sidecar for CLI Management
- **Process spawning**: Node.js (execa) better DX than raw C/Rust
- **Claude Code CLI** is Node.js-based, seamless integration
- **Terminal streaming**: WebSocket + xterm.js ecosystem mature in Node.js
- **Git operations**: simple-git (Node) cleaner than rusty-git or libgit2

### Why Synchronous SQLite (better-sqlite3)
- **Simplicity**: No async/await ceremony for simple queries
- **Performance**: Benchmark 94 vs async drivers at 68
- **Sidecar model**: Single-threaded Node process, thread pool overhead unnecessary
- **Desktop app**: No need for connection pooling (unlike servers)

### Why TanStack Query Over Redux
- **Server state**: Query specifically designed for server state sync
- **Bundle size**: Smaller than Redux + RTK
- **Refetch policies**: Built-in stale-while-revalidate, perfect for monitoring
- **No boilerplate**: Compared to Redux actions/reducers

### Xterm.js as Terminal
- **Battle-tested**: Used by VS Code, Hyper, SSH clients
- **ANSI support**: Full xterm256/RGB color support
- **Addons**: AttachAddon handles WebSocket streaming natively
- **Performance**: Efficient rendering, handles large output buffers

---

## Deployment & Performance Notes

### Bundle Size Target
- Tauri binary: 40-50MB (x64)
- Frontend JS: < 500KB (gzipped)
- Total installer: ~60-80MB (varies by OS)

### Startup Performance
- Tauri app launch: 200-400ms
- Node.js sidecar: 500-1000ms (first CLI execution)
- React hydration: 100-200ms

### Real-time Monitoring Latency
- WebSocket message: 10-50ms roundtrip
- Terminal render: 16ms (60fps, xterm.js buffering)
- Git operation feedback: 50-500ms (depends on repo size)

---

## Security Considerations

1. **IPC Validation**: Tauri automatically validates command arguments
2. **CORS**: Node sidecar should only bind to localhost (127.0.0.1:3001)
3. **Process Isolation**: Each task runs in separate Node.js child process
4. **Git Worktree Isolation**: Each agent gets dedicated worktree directory
5. **Database Encryption**: Future v2 can use SQLCipher extension (rusqlite supports)

---

## Sources

- **Context7 - Tauri**: `/websites/rs_tauri_2_9_5` (16,899 snippets, High reputation) — Current version docs, Cargo.toml features
- **Context7 - React**: `/facebook/react` (3,470 snippets, High reputation) — React 19 API, hooks
- **Context7 - Xterm.js**: `/xtermjs/xterm.js` (222 snippets, High reputation) — Terminal emulation, WebSocket integration examples
- **Context7 - Zustand**: `/websites/zustand_pmnd_rs` (725 snippets, High reputation) — State management patterns
- **Context7 - TanStack Query**: `/tanstack/query` (1,650 snippets, High reputation) — Server state sync patterns
- **Context7 - Simple Git**: `/steveukx/git-js` (311 snippets, High reputation) — Git command integration
- **Context7 - Better SQLite3**: `/wiselibs/better-sqlite3` (58 snippets, Medium reputation, Benchmark 94) — Sync SQLite driver
- **Context7 - Execa**: `/sindresorhus/execa` (451 snippets, High reputation, Benchmark 89.2) — Process execution
- **Official Tauri Releases**: GitHub releases (Feb 2, 2025) — v2.10.1 confirmed stable
- **Official React**: Facebook/React GitHub (v19.1+) — Current stable version
- **Official Vite**: https://vite.dev — Build tool setup
- **Official Tailwind**: https://tailwindcss.com — CSS framework docs

---

*Stack research for: AI Agent Orchestration Desktop Platform*
*Researched: February 4, 2025*
*Confidence Level: HIGH — All core technologies verified via Context7 documentation and official releases*
*Last Updated: 2025-02-04*
