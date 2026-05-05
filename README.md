<p align="center">
  <img src="public/maestro-logo.png" alt="Maestro" width="200" />
</p>

# Maestro

Desktop app for orchestrating autonomous AI coding agents. Queue tasks on a Kanban board, agents execute in isolated git worktrees with real-time monitoring and human review gates.

## Features

- **Kanban workflow** — Backlog → Ready → In Progress → Review → Done with drag-and-drop
- **Parallel execution** — Multiple agents run simultaneously in isolated git worktrees
- **Live monitoring** — Real-time terminal output, structured ACP activity feed, and file tree navigation
- **Diff review** — Inline file diff viewer with hunk-level staging, revert, and commit workflow
- **SSH remotes** — Connect to remote projects over SSH; password, key, and passphrase auth
- **Issue import** — Sync tasks from GitHub and Jira
- **Model selection** — Per-task model configuration and MCP allowlists
- **Theme** — Light, dark, and system themes

## Tech Stack

| Layer    | Technology                                               |
| -------- | -------------------------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, shadcn/ui    |
| State    | Zustand + Immer, TanStack Query                          |
| Terminal | xterm.js                                                 |
| Desktop  | Tauri 2 (Rust)                                           |
| Database | SQLite (rusqlite)                                        |
| SSH      | russh                                                    |
| Protocol | ACP (Agent Client Protocol) via `maestro-server` sidecar |
| Type gen | ts-rs + tauri-specta                                     |

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform
- `maestro-server` binary on `PATH` for agent execution

## Getting Started

```bash
# Install dependencies
pnpm install

# Run in development (Tauri + Vite)
pnpm tauri:dev
```

## Development Commands

```bash
# Frontend
pnpm dev              # Vite dev server only (localhost:5173)
pnpm build            # TypeScript check + production build
pnpm lint             # oxlint
pnpm lint:fix         # Auto-fix lint issues
pnpm format           # Check formatting (oxfmt)
pnpm format:fix       # Fix formatting

# Testing
pnpm test             # Vitest unit tests
pnpm test <pattern>   # Single test file
pnpm test:e2e         # Playwright E2E tests
pnpm test:e2e:ui      # Playwright with interactive UI

# Rust backend
cd src-tauri && cargo build
cd src-tauri && cargo test
cd src-tauri && cargo check

# Tauri
pnpm tauri:dev        # Full dev mode (Tauri + Vite)
pnpm tauri:gen        # Regenerate TypeScript bindings from Rust models
pnpm tauri build      # Production bundle (all platforms)

# Cross-compile for Windows from Linux
pnpm tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc
```

## Architecture

Three Rust crates in a Cargo workspace:

- **`src-tauri`** — Tauri backend. IPC command handlers, SQLite DB, SSH tunneling, PTY management, ACP session coordination.
- **`maestro-server`** — Standalone binary (must be on `PATH`). ACP intermediary between Tauri and AI agents. Communicates via JSON-framed messages on stdin/stdout.
- **`maestro-protocol`** — Shared ACP protocol types.

Frontend (`src/`) organized as:

```
src/
├── components/
│   ├── common/       # App header, review modal, theme toggle
│   ├── execution/    # Agent terminal, diff viewer, worktree cards
│   ├── kanban/       # Board, columns, task cards
│   ├── project-picker/
│   ├── task/         # Task form, settings, import
│   └── ui/           # shadcn/ui primitives
├── services/         # TanStack Query service layer
├── store/            # Zustand stores
├── types/            # Generated bindings (bindings.ts) + domain types
├── utils/
│   ├── helpers/
│   └── hooks/
└── views/            # Top-level views (Kanban, Agents, Worktrees, Settings)
```

See `CLAUDE.md` for development conventions and AI agent guidelines.

## License

GPL-3.0-only
