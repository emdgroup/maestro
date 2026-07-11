<p align="center">
  <img src="public/maestro-logo.png" alt="Maestro" width="180" />
</p>

<h3 align="center">Run multiple AI coding agents in parallel — without losing control.</h3>

<p align="center">
  <a href="https://github.com/emdgroup/maestro/releases/latest"><img src="https://img.shields.io/github/v/release/emdgroup/maestro?label=latest" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
</p>

---

<!-- TODO: Add demo GIF — 30s recording: open project → create task → run agent → live terminal → review diff → commit -->

---

Drop tasks onto a Kanban board. Each one gets its own agent, its own git worktree, and its own terminal. They run in parallel. Nothing conflicts. When an agent finishes, review the diff hunk by hunk and commit what you want — all without leaving the app.

---

## Install

| Platform                            | Download                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS — Apple Silicon (M1/M2/M3/M4) | [Maestro_0.8.0_aarch64.dmg](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_aarch64.dmg)                     |
| Linux — x86_64                      | [Maestro_0.8.0_amd64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_amd64.AppImage) ✓ recommended |
| Linux — x86_64 (no auto-update)     | [Maestro_0.8.0_amd64.deb](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_amd64.deb)                         |
| Linux — arm64                       | [Maestro_0.8.0_aarch64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_aarch64.AppImage)           |
| Windows — x86_64                    | [Maestro_0.8.0_x64-setup.exe](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_x64-setup.exe) ✓ recommended   |
| Windows — x86_64 (MSI)              | [Maestro_0.8.0_x64_en-US.msi](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_0.8.0_x64_en-US.msi)                 |

The `.dmg`, `.AppImage`, and `.exe` installers include automatic in-app updates. The `.deb` package does not — Maestro will prompt you to download the new version when one is available.

---

## Quick start

1. Open Maestro and point it at a local git repository
2. Create a task on the Kanban board — add a title and instructions
3. Pick a model and click **Run** — the agent starts in an isolated worktree
4. Watch the live terminal and activity feed as it works
5. Review the diff hunk by hunk, stage what you want, commit in one click

---

## Features

### Parallel agents, zero conflicts

<!-- TODO: screenshot — Kanban board with 3+ tasks in "In Progress" simultaneously -->

Each task runs in its own git worktree. Agents work independently — no branch conflicts, no clobbering each other's changes. Run as many as you want simultaneously.

### Live visibility

<!-- TODO: screenshot — execution panel with live terminal and ACP activity feed -->

Live terminal output, a structured activity feed, and a file tree — all updating in real time. You see exactly what every agent is doing at every step.

### Surgical diff review

<!-- TODO: screenshot — diff viewer with hunk-level staging controls -->

When an agent finishes, you get an inline diff viewer with hunk-level staging. Accept what you want, revert what you don't, commit in one click.

### Remote execution

Connect Maestro to a remote Linux server over SSH, or to a WSL distro on Windows. Agents execute on the remote machine while you work locally. Password, key, and passphrase auth all supported.

### Pull from your issue tracker

<!-- TODO: screenshot — task import dialog showing GitHub Issues or Jira -->

Sync tasks directly from GitHub Issues or Jira. Import a ticket, add instructions, hand it to an agent.

### Your stack, your models

Pick the model per task. Configure MCP allowlists. Maestro stays out of the way.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, branch conventions, and PR guidelines.

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
pnpm tauri build      # Production bundle

# Cross-compile for Windows from Linux
pnpm tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc
```

### Architecture

Three Rust crates in a Cargo workspace:

- **`src-tauri`** — Tauri backend: IPC command handlers, SQLite DB, SSH tunneling, PTY management, ACP session coordination.
- **`maestro-server`** — Agent runtime sidecar, automatically deployed at runtime.
- **`maestro-protocol`** — Shared ACP protocol types.

See [`AGENTS.md`](AGENTS.md) for a full architecture walkthrough.

---

## License

Apache-2.0
