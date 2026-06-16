<p align="center">
  <img src="public/maestro-logo.png" alt="Maestro" width="200" />
</p>

<p align="center">
  <strong>Run multiple AI coding agents in parallel — without losing control.</strong>
</p>

<p align="center">
  <a href="https://github.com/m306213/maestro/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-orange" alt="Tauri" />
</p>

---

Maestro is a desktop app that turns your backlog into shipped code. Drop tasks onto a Kanban board, let agents execute them in parallel, then review and merge — all without leaving a single window.

---

## How it works

```
Backlog  →  Ready  →  In Progress  →  Review  →  Done
              ↓             ↓              ↓
           assign        agent runs     diff viewer
           model         in isolated    hunk staging
                         worktree       one-click commit
```

Each task gets its own agent, its own git worktree, and its own terminal. They run in parallel. Nothing conflicts.

---

## Features

### Parallel agents, zero conflicts

Each task runs in an isolated git worktree. Agents don't step on each other, and you can have as many in flight as you want.

### Real-time visibility

Live terminal output, a structured activity feed, and a file tree — all updating as agents work. You see exactly what's happening at every step.

### Surgical diff review

When an agent finishes, you get an inline diff viewer with hunk-level staging. Accept what you want, revert what you don't, commit in one click.

### Any machine, any location

Runs natively on macOS and Linux. On Windows, connect to a WSL distro or SSH into a remote Linux server — agents execute there while you work locally. Password, key, and passphrase auth all supported.

### Pull work from your tracker

Sync tasks directly from GitHub Issues or Jira. Import a ticket, add instructions, hand it to an agent.

### Your stack, your models

Pick the model per task. Configure MCP allowlists. Maestro stays out of the way.

---

## At a glance

| Capability        | Detail                                                       |
| ----------------- | ------------------------------------------------------------ |
| Kanban workflow   | Backlog → Ready → In Progress → Review → Done, drag-and-drop |
| Parallel agents   | Multiple agents run simultaneously in isolated git worktrees |
| Live monitoring   | Real-time terminal, ACP activity feed, file tree             |
| Diff review       | Inline viewer with hunk-level staging, revert, and commit    |
| SSH & WSL remotes | Connect to remote and WSL projects with full auth support    |
| Issue import      | Sync from GitHub Issues and Jira                             |
| Model selection   | Per-task model and MCP allowlist configuration               |
| Themes            | Light, dark, and system                                      |

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
- [Node.js 20+](https://nodejs.org/) + [pnpm](https://pnpm.io/)
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

---

## License

GPL-3.0-only
