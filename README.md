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

> [!WARNING]
> Maestro is under active development. Features may be heavily modified or removed without notice, and the UI changes frequently between releases.

<p align="center"><img src="docs/assets/maestro-workflow.webp" alt="Running a task from the Kanban board, watching the agent work, and reviewing its diff in Maestro" width="960" /></p>

---

Drop tasks onto a Kanban board and give each one its own coding agent and terminal. With Git enabled, tasks can also run in isolated worktrees so agents work in parallel without clobbering each other's changes. When an agent finishes, review the diff hunk by hunk and commit what you want — all without leaving the app.

## Product tour

Maestro keeps the full agent workflow in one place:

1. **Plan** — turn work into focused tasks on the Kanban board
2. **Run in parallel** — give every task an agent and an isolated git worktree
3. **Stay informed** — follow terminal output, agent activity, and changed files live
4. **Review precisely** — inspect and stage changes at hunk level
5. **Ship deliberately** — commit only the changes you approve

---

## Install

| Platform                            | Download                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS — Apple Silicon (M1/M2/M3/M4) | [Maestro_macos_aarch64.dmg](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_macos_aarch64.dmg)                             |
| Linux — x86_64                      | [Maestro_linux_x86_64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_x86_64.AppImage) ✓ recommended       |
| Linux — x86_64 (no auto-update)     | [Maestro_linux_x86_64.deb](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_x86_64.deb)                               |
| Linux — arm64                       | [Maestro_linux_aarch64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_aarch64.AppImage)                   |
| Windows — x86_64                    | [Maestro_windows_x86_64-setup.exe](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_windows_x86_64-setup.exe) ✓ recommended |
| Windows — x86_64 (MSI)              | [Maestro_windows_x86_64.msi](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_windows_x86_64.msi)                           |

The `.dmg`, `.AppImage`, and `.exe` installers include automatic in-app updates. The `.deb` package does not — Maestro will prompt you to download the new version when one is available.

---

## Before you start

**No Maestro account is required.** Install the app and use it directly — there is no Maestro service to register for or sign in to.

### Set up a coding agent

Maestro orchestrates coding agents but does not provide an agent account or model access. Install and authenticate the agent of your choice before using it with Maestro. Supported agents include Claude Code, Codex, OpenCode, Gemini CLI, Goose, Cline, and other [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agents.

Some agents are launched through `npx` or `uvx` rather than a standalone executable. Depending on your chosen agent, you may also need:

- [`npx`](https://docs.npmjs.com/cli/v11/commands/npx), included with Node.js and npm
- [`uvx`](https://docs.astral.sh/uv/guides/tools/), included with uv

Agent authentication, subscriptions, model availability, and usage charges are managed by the agent's provider, not by Maestro.

### Git is optional, but recommended

Maestro can run agents in a regular folder without Git. For the complete workflow, use a Git repository: Git enables isolated worktrees, parallel agents without overlapping changes, inline diff review, hunk-level staging, and commits from Maestro.

Without Git, agents work directly in the selected folder and completed tasks move directly to **Done** instead of **Review**.

### Credentials stay local

Maestro does not store remote connection or tool integration credentials in its SQLite database. When you choose to save them, SSH passwords, SSH key passphrases, and integration credentials are stored in your operating system's keychain. Coding-agent credentials remain managed by the agent itself.

If the OS keychain is unavailable, Maestro can store integration credentials in an encrypted local file and displays a warning. SSH secrets are not persisted through this fallback.

---

## Quick start

1. Install and authenticate your preferred coding agent
2. Open Maestro and select a local folder or Git repository
3. Create a task on the Kanban board — add a title and instructions
4. Pick an agent and model, then click **Run**
5. Watch the live terminal and activity feed as it works
6. In a Git repository, review the diff, stage what you want, and commit in one click

---

## Features

### Parallel agents, zero conflicts

<img src="docs/assets/kanban-board.webp" alt="Maestro Kanban board with two agents running on isolated tasks and more waiting in Queue and Review" width="960" />

In a Git repository, each task can run in its own worktree. Agents work independently — no branch conflicts and no clobbering each other's changes. Run multiple agents concurrently, limited by your machine, remote host, and provider limits.

### Live visibility

<img src="docs/assets/live-execution.webp" alt="A running Maestro session showing the agent activity feed, its tool calls, and the changed files panel" width="960" />

Live terminal output, a structured activity feed, and a file tree — all updating in real time. You see exactly what every agent is doing at every step.

### Surgical diff review

<img src="docs/assets/diff-review.webp" alt="Maestro diff viewer showing two hunks of an agent's change with per-hunk staging controls" width="960" />

When an agent finishes in a Git repository, you get an inline diff viewer with hunk-level staging. Accept what you want, revert what you don't, commit in one click.

### Remote execution

Connect Maestro to a remote Linux server over SSH, or to a WSL distro on Windows. Agents execute on the remote machine while you work locally. Password, key, and passphrase auth all supported.

### Pull from your issue tracker

<!-- Still to capture: docs/assets/issue-import.webp — needs a tracker connection, see docs/presentation-assets.md -->

Sync tasks directly from GitHub Issues or Jira. Import a ticket, add instructions, hand it to an agent.

### Your agents, your models

Use your preferred ACP-compatible coding agent and pick the model per task. Configure MCP allowlists while agent authentication and billing stay with the provider. Maestro stays out of the way.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, branch conventions, and PR guidelines.

For README screenshots and the short product demo, follow the [presentation asset guide](docs/presentation-assets.md).

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
bun dev              # Vite dev server only (localhost:5173)
bun build            # TypeScript check + production build
bun lint             # oxlint
bun lint:fix         # Auto-fix lint issues
bun format           # Check formatting (oxfmt)
bun format:fix       # Fix formatting

# Testing
bun test             # Vitest unit tests
bun test <pattern>   # Single test file

# Rust backend
cd src-tauri && cargo build
cd src-tauri && cargo test
cd src-tauri && cargo check

# Tauri
bun tauri:dev        # Full dev mode (Tauri + Vite)
bun tauri:gen        # Regenerate TypeScript bindings from Rust models
bun tauri build      # Production bundle

# Cross-compile for Windows from Linux
bun tauri build --debug --runner cargo-xwin --target x86_64-pc-windows-msvc
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
