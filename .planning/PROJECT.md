# AI Agent Orchestrator

## What This Is

A desktop orchestration tool for managing autonomous AI coding agents. Users queue tasks on a Kanban board, and agents execute them in isolated git worktrees with real-time monitoring and human review gates. Built on Claude Code CLI with an extensible architecture for multi-agent workflows.

## Core Value

Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control—eliminating blocking waits while maintaining safety through worktree isolation and human-in-the-loop review.

## Current State

**Latest Release:** v1.0 MVP (shipped 2026-02-09)

**What was built:**
- Complete AI agent orchestration platform with Kanban workflow, worktree isolation, real-time monitoring, and autonomous execution modes
- 12 phases delivered (Foundation → Worktree Disk Cleanup)
- All 28 v1.0 requirements satisfied
- Zero critical gaps, zero tech debt
- Full audit passed with 100% requirements coverage

**Production Status:** Ready for release ✓

## Current Milestone: v1.1 UI/UX Polish

**Goal:** Fix critical bugs and dramatically improve visual design with modern, clean aesthetic based on mockup.

**Target features:**
- Fix tauri-mock.ts leak into release builds
- Complete UI redesign (Kanban board, Agent monitor, Worktree manager, Settings)
- Theming system (light/dark with system default)
- Clean up Rust build warnings
- Migrate to Tailwind CSS + shadcn/ui components
- Replace global CSS with CSS modules where Tailwind isn't sufficient

## Requirements

### Validated

**v1.0 Requirements (shipped 2026-02-09):**

- ✓ Project initialization with git worktree setup — v1.0
- ✓ Kanban board UI (Backlog → Ready → In Progress → Review → Done) — v1.0
- ✓ Manual task creation with description, context, acceptance criteria — v1.0
- ✓ GitHub/Jira issue import with auto-sync on project open — v1.0
- ✓ Task configuration (model selection, MCP allowlist, Skills selection) — v1.0
- ✓ Hybrid worktree pool management (pre-create pool, expand dynamically) — v1.0
- ✓ Agent session execution using Claude Code CLI — v1.0
- ✓ Real-time monitoring (live terminal output + file diff viewer) — v1.0
- ✓ Embedded terminal with attach/detach for manual control — v1.0
- ✓ Review workflow with file diffs and approve/reject — v1.0
- ✓ Merge approval workflow with automatic worktree cleanup — v1.0
- ✓ Project settings UI for Claude Code configuration — v1.0
- ✓ Project-level MCP server defaults (stored in database) — v1.0
- ✓ Project-level Skills defaults (stored in database) — v1.0
- ✓ Task-level MCP/Skills override (restrict per task) — v1.0
- ✓ SQLite state persistence per project — v1.0
- ✓ Error handling (pause for human intervention on agent failures) — v1.0
- ✓ Project-level model default with task-level override — v1.0
- ✓ Remote project support via SSH tunneling — v1.0
- ✓ Remote agent execution with terminal streaming — v1.0
- ✓ Pause/resume mechanism with UI controls — v1.0
- ✓ Failure notifications with toast alerts — v1.0
- ✓ Status badges with elapsed time display — v1.0
- ✓ Worktree disk cleanup after merge — v1.0

### Active

**v1.1 Requirements (in progress):**

(Will be defined through requirements gathering process)

### Out of Scope

- Multi-project switching — defer to v2 (MVP focuses on single project workflow)
- Remote session management — defer to v2 (SSH tunneling architecture designed but not implemented)
- OpenCode and other CLI tools — defer to v2 (MVP is Claude Code only)
- Plugin marketplace — defer to v2 (leverage existing Claude Code plugin architecture)
- Multi-user collaboration — defer to v2+ (single user focus)
- Cloud relay for remote sessions — defer to v3+ (SSH tunneling sufficient)
- Custom worktree retention policies — defer to v2 (clean up immediately after merge)
- Webhook integration for issue sync — defer to v2 (auto-sync on open sufficient)

## Context

**Current codebase:**
- Tech stack: Tauri 2 + React 19 + Rust backend + Node.js sidecar
- Lines of code: ~111,223 (TypeScript + Rust)
- Database: SQLite with 6-version schema evolution
- All 27 unit tests passing

**v1.0 shipped features:**
- Complete Kanban workflow (create, import, drag-drop)
- Agent execution with real worktree isolation
- Real-time terminal monitoring with streaming
- Human-in-the-loop review gate with file diffs
- Automatic merge and disk cleanup
- Error handling with pause/resume and notifications
- Remote project support via SSH with streaming
- Configuration management (storage complete)

**Known issues:**
- None (all Phase 4 tech debt closed by Phases 10-12)

**Technical debt:**
- Zero remaining (all 7 identified gaps closed)

**User feedback themes:**
- Not yet deployed (awaiting first production release)

## Constraints

- **Tech Stack**: Tauri 2 + React + Rust backend + Node.js sidecar (for Claude Code CLI integration)
- **State Storage**: SQLite database per project (single .db file in `.toolstate/` directory)
- **MVP Scope**: Single local project only—no multi-project switching in v1
- **CLI Integration**: Claude Code CLI only in v1—architecture must support future CLI tools
- **Remote Protocol**: SSH tunneling (design for v2, not implement in v1)
- **Version Control**: Requires git repository (auto-initialize if needed)
- **Platform**: Desktop-first (macOS, Windows, Linux via Tauri)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri over Electron | Lighter weight (Rust vs Chromium), faster startup, better security model | ✓ Good — ~111K LOC, fast startup, 27 tests passing |
| Rust + Node sidecar | Rust for performance, Node.js for Claude Code CLI integration (spawning processes, parsing output) | ✓ Good — Clean separation of concerns, sidecar handles git ops |
| SQLite for state | Queryable, single file, no server overhead, good tooling | ✓ Good — Schema v6 with migrations, reliable persistence |
| Hybrid worktree pool | Pre-create 3-5 worktrees for instant allocation, expand dynamically if exhausted, avoids pool exhaustion | ✓ Good — Instant allocation, automatic retry with expansion |
| Cleanup after merge | Delete worktree + branch immediately after merge to main (prevents stale branches, keeps repo clean) | ✓ Good — Phase 12 added full disk cleanup via sidecar |
| React over Svelte | User preference despite Svelte's lighter weight and better Tauri integration | ✓ Good — No issues encountered, React 19 works well |
| GitHub-style workflow | Backlog → Ready → In Progress → Review → Done (familiar pattern, explicit review gate) | ✓ Good — Clear workflow, users understand gates |
| Project-level defaults + task overrides | MCP/model/skills set at project level, restrict per task (balances convenience with control) | ✓ Good — Stored in database, ready for agent consumption |
| File diff review (not IDE) | Embedded diff viewer with syntax highlighting (Phase 6-01) | ✓ Good — @git-diff-view/react works well, no external tools |
| Pause on agent error | Stop execution, notify user, wait for intervention (safety over autonomy) | ✓ Good — Toast notifications, pause/resume UI (Phase 11) |
| Auto-sync issues on open | GitHub/Jira issues sync when opening project (simpler than webhooks, good-enough freshness) | ✓ Good — Sync button with toast feedback |
| SSH for remote projects | SSH tunneling for all remote operations (git, execution, streaming) | ✓ Good — Transparent to users, identical UX (Phase 9) |
| PTY-based terminal streaming | portable-pty + Tauri channels for real-time output | ✓ Good — Works for both local and remote (Phase 5) |
| @dnd-kit over react-beautiful-dnd | React 19 peer-dep compatibility | ✓ Good — Drag-drop works smoothly (Phase 2) |

---
*Last updated: 2026-02-09 — v1.1 milestone started*
