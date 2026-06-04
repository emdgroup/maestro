<p align="center">
  <img src="public/maestro-logo.png" alt="Maestro" width="200" />
</p>

# Maestro

**Run multiple AI coding agents in parallel — without losing control.**

Maestro is a desktop app that turns your backlog into shipped code. Queue tasks, watch agents work in real-time, review diffs, and merge — all without leaving a single window.

---

## What it does

### Queue tasks, agents execute
Drop tasks onto the Kanban board. Maestro spins up an AI agent per task, each working in its own isolated git worktree. No conflicts. No shared state. Just parallel progress.

### Watch every move in real-time
Live terminal output, structured activity feed, and file tree navigation — all updating as your agents work. You're never flying blind.

### Review before it lands
When an agent finishes, the task moves to Review. You get an inline diff viewer with hunk-level staging: accept what you want, revert what you don't, then commit in one click.

### Work on any machine
SSH into a remote server or WSL distro and run agents there. Password, key, and passphrase auth all supported. Your local machine stays fast; the heavy lifting happens where you point it.

### Pull work from your tracker
Sync tasks directly from GitHub Issues or Jira. Import a ticket, add instructions, and hand it to an agent — no copy-pasting.

### Control which model does what
Pick the model per task. Configure MCP allowlists. Maestro gets out of the way and lets you run the stack you want.

---

## Features at a glance

| | |
|---|---|
| Kanban workflow | Backlog → Ready → In Progress → Review → Done with drag-and-drop |
| Parallel agents | Multiple agents run simultaneously in isolated git worktrees |
| Live monitoring | Real-time terminal, ACP activity feed, file tree |
| Diff review | Inline viewer with hunk-level staging, revert, and commit |
| SSH & WSL remotes | Connect to remote and WSL projects with full auth support |
| Issue import | Sync from GitHub Issues and Jira |
| Model selection | Per-task model and MCP allowlist configuration |
| Themes | Light, dark, and system |

---

---

## For contributors

### Tech stack

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

### Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform
- `maestro-server` binary on `PATH` for agent execution

### Getting started

```bash
pnpm install
pnpm tauri:dev
```

### Development commands

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

### Architecture

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
