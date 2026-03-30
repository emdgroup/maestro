# Maestro

## What This Is

A desktop orchestration tool for managing autonomous AI coding agents. Users queue tasks on a Kanban board, and agents execute them in isolated git worktrees with real-time monitoring and human review gates. Built on Claude Code CLI with an extensible architecture for multi-agent workflows. Features a modern, polished UI with Tailwind CSS + shadcn/ui, per-project `.maestro/` local storage, and a full service-layer architecture for clean frontend/backend separation.

## Core Value

Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control—eliminating blocking waits while maintaining safety through worktree isolation and human-in-the-loop review.

## Current State

**Latest Release:** v1.2 Deep Linking & Project Picker (shipped 2026-03-29)

**Active milestone:** v1.3 Agents & Worktrees — Phase 28 complete (last phase), milestone ready for ship

**What was built in Phase 28 (zombie-cleanup-on-project-open):**
- `cleanup_zombie_worktrees` Rust IPC command — queries DB for worktrees with no task / task Done/Cancelled, older than 10 min, confirmed on disk; deletes worktree + DB row
- `useCleanupZombieWorktreesMutation` TanStack Query mutation — fires silently on project open, invalidates worktrees cache only when deletedCount > 0, errors logged not toasted
- App.tsx `useEffect([currentProject?.id])` — triggers cleanup on every project open and project switch (Validated in Phase 28: zombie-cleanup-on-project-open)

**What was built in Phase 27 (worktrees-view):**
- `WorktreeWithStatus` extended with `diff_stat: Option<String>` populated via `git diff --shortstat` (parallel tokio spawn)
- `worktree.service.ts` — TanStack Query hooks: `useWorktreesQuery` (5s poll), `useWorktreeDiffQuery`, `useDeleteWorktreeMutation`, `useCreateWorktreeMutation`
- `WorktreeManager.tsx` — AgentMonitor-style `w-72` sidebar with All/Active/Modified/Idle filters + branch search, status dots, Zombie/Orphan badges, diff shortstat, task deep links
- Right detail panel: branch metadata, task link, status badge, `formatDistanceToNow` timestamp, `DiffViewer` per-file, AlertDialog-gated delete, New Worktree creation dialog

**What was built in Phase 26 (agents-view):**
- `useExecutionsWithTaskInfoQuery` polling hook (2s interval) — AgentsView as sole data owner
- AgentMonitor rewrite: three-line sidebar rows, filter toolbar, left-border selection, terminal routing
- `DeadSessionTerminal` for completed/failed execution history (write-only xterm.js, no PTY)
- REQ-22 compliant Terminal cleanup: ResizeObserver.disconnect → detachTerminal → terminal.dispose
- Deep-link resolution via `pendingAgentId` from navigationStore, auto-select fallback for running sessions

**What was built in Phase 25 (backend-overhaul):**
- SQLite schema migrated to v3: pool columns removed, `task_id`/`git_status` added to worktrees
- `WorktreeWithStatus` and `ExecutionWithTask` view models replace pool-based types
- All git stubs replaced with real `tokio::process::Command` async implementations
- 4 new worktree IPC commands: `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`
- Execution handlers migrated to on-demand worktree lifecycle (create on spawn, delete on finish)
- `list_executions_with_task_info` IPC command added; TypeScript bindings regenerated

**Production Status:** v1.2 shipped ✓ | v1.3 backend foundation complete ✓

**Tech stack:**
- Frontend: React 19 + TypeScript + Tailwind CSS 4.1 + shadcn/ui + TanStack Query
- Backend: Tauri 2 (Rust) + SQLite + SSH
- State: Zustand + Immer (global), TanStack Query (server state)
- LOC: ~16,500 TypeScript | ~7,000 Rust (estimated)

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

**v1.1 Requirements (shipped 2026-03-16):**

- ✓ Mock IPC handlers excluded from production builds — v1.1 (Phase 13)
- ✓ Zero Rust build warnings — v1.1 (Phase 13)
- ✓ Tailwind CSS utilities available throughout app — v1.1 (Phase 14)
- ✓ shadcn/ui components available throughout app — v1.1 (Phase 15)
- ✓ Light/dark/system theme switching with persistence — v1.1 (Phase 14)
- ✓ No flash of unstyled content on startup — v1.1 (Phase 14)
- ✓ Consistent components using shadcn/ui — v1.1 (Phase 15)
- ✓ Modern Kanban board with animated status dots — v1.1 (Phase 16)
- ✓ Modern Agent Monitor with split-pane interface — v1.1 (Phase 16)
- ✓ Modern Worktree Manager card grid — v1.1 (Phase 16)
- ✓ Modern Settings panel with sectioned layout — v1.1 (Phase 16)
- ✓ App header with inline project dropdown + tab navigation — v1.1 (Phase 17.1)
- ✓ System accent color integration — v1.1 (Phase 17.1)
- ✓ FiraCode/Inter typography system — v1.1 (Phase 15)
- ✓ Compact design system (text-xs, h-7, p-3 patterns) — v1.1 (Phase 15)

**v1.2 Requirements (shipped 2026-03-29):**

- ✓ Programmatic in-app navigation via `navigationStore` discriminated union API — v1.2 (Phase 23)
- ✓ Deep linking to tasks, agents, worktrees by entity ID — v1.2 (Phase 23)
- ✓ `git init` auto-run on folder select in project picker — v1.2 (Phase 24)
- ✓ Clone Project dialog (git URL + target path + SSH remote support) — v1.2 (Phase 24)
- ✓ Create Project dialog (parent dir + folder name + git init) — v1.2 (Phase 24)

## Current Milestone: v1.3 Agents & Worktrees

**Goal:** Replace both placeholder views with fully functional, real-data-backed Agents and Worktrees management screens — including a backend overhaul from pool-based to on-demand worktree creation.

**Target features:**
- Agents view: execution log list (active + history), live xterm.js terminal attach, search/filter, graceful handling of dead sessions
- Worktrees view: real git worktree listing with branch/task/diff info, create + delete, zombie detection and cleanup
- Backend: remove worktree pool, on-demand worktree creation per task, new IPC for worktree listing and git diff

### Active

### Out of Scope

- Multi-project switching — defer to v2 (MVP focuses on single project workflow)
- OpenCode and other CLI tools — defer to v2 (MVP is Claude Code only)
- Plugin marketplace — defer to v2 (leverage existing Claude Code plugin architecture)
- Multi-user collaboration — defer to v2+
- Cloud relay for remote sessions — defer to v3+ (SSH tunneling sufficient)
- Custom worktree retention policies — defer to v2 (clean up immediately after merge)
- Webhook integration for issue sync — defer to v2 (auto-sync on open sufficient)
- Light mode full implementation — deferred from v1.1 (dark-first approach)
- Custom theme color picker — defer to v1.2+
- Mobile/responsive design — desktop-first, defer to v2+

## Context

**Current codebase:**
- Tech stack: Tauri 2 + React 19 + TypeScript + Rust backend + Node.js sidecar
- UI: Tailwind CSS 4.1 + shadcn/ui + TanStack Query
- Lines of code: 15,398 TypeScript | 6,553 Rust
- Database: SQLite with schema v1, plus per-project `.maestro/` JSON files
- Architecture: views/ + services/ + components/{domain}/ + utils/hooks/ + utils/helpers/

**Known issues:**
- None

**Technical debt:**
- None remaining from v1.1

**User feedback themes:**
- Not yet deployed publicly (awaiting first production release)

## Constraints

- **Tech Stack**: Tauri 2 + React + Rust backend + Node.js sidecar (for Claude Code CLI integration)
- **State Storage**: SQLite database (global app state) + per-project `.maestro/` JSON files
- **CLI Integration**: Claude Code CLI only in v1—architecture must support future CLI tools
- **Remote Protocol**: SSH tunneling for remote project access
- **Version Control**: Requires git repository (auto-initialize if needed)
- **Platform**: Desktop-first (macOS, Windows, Linux via Tauri)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri over Electron | Lighter weight (Rust vs Chromium), faster startup, better security model | ✓ Good — fast startup, 15K TS + 6.5K Rust LOC |
| Rust + Node sidecar | Rust for performance, Node.js for Claude Code CLI integration | ✓ Good — clean separation, sidecar handles git ops |
| SQLite for state | Queryable, single file, no server overhead | ✓ Good — reliable persistence |
| Hybrid worktree pool | Pre-create 3-5 worktrees, expand dynamically | ✓ Good — instant allocation, automatic retry |
| Cleanup after merge | Delete worktree + branch immediately after merge | ✓ Good — Phase 12 added full disk cleanup |
| React over Svelte | User preference despite Svelte's lighter weight | ✓ Good — React 19 works well with Tauri |
| GitHub-style workflow | Backlog → Ready → In Progress → Review → Done | ✓ Good — clear workflow, explicit review gate |
| File diff review (not IDE) | Embedded diff viewer with syntax highlighting | ✓ Good — @git-diff-view/react works well |
| Pause on agent error | Stop execution, notify user, wait for intervention | ✓ Good — toast notifications, pause/resume UI |
| Auto-sync issues on open | GitHub/Jira issues sync when opening project | ✓ Good — sync button with toast feedback |
| SSH for remote projects | SSH tunneling for all remote operations | ✓ Good — transparent to users, identical UX |
| PTY-based terminal streaming | portable-pty + Tauri channels for real-time output | ✓ Good — works for both local and remote |
| @dnd-kit over react-beautiful-dnd | React 19 peer-dep compatibility | ✓ Good — drag-drop works smoothly |
| Tailwind CSS 4.1 + @tailwindcss/vite | Official recommendation, 8kB bundle savings | ✓ Good — fast builds, utilities throughout app |
| shadcn/ui over custom components | Copy-paste workflow reduces coupling | ✓ Good — theme-aware via CSS variables |
| System-first theme | Follows OS preference, respects user's settings | ✓ Good — dual preload prevents FOUC |
| TanStack Query for all IPC | Consistent data fetching, caching, mutations | ✓ Good — 37 hooks, 0 direct invoke() in UI |
| views/services/components architecture | Standard industry structure | ✓ Good — clear separation of concerns |
| .maestro/ per-project folder | Project-local state, not global DB | ✓ Good — projects are self-contained |
| DB mutex released before async SSH I/O | Prevent deadlock in get_connection_projects | ✓ Good — helper function pattern resolves lifetime issues |
| Stale project cleanup on fetch | Transparent, no UI change needed | ✓ Good — verified for both local + SSH |
| Zustand navigationStore with discriminated union | Programmatic deep linking from any component without prop drilling | ✓ Good — clean API, 17 tests, replaces local usePageRouting state |
| `navigate()` uses `'key' in target` narrowing | TypeScript discriminated union dispatch, no switch fallthrough | ✓ Good — avoids stale closure issues |
| Inline DB logic in async IPC commands | Avoid `State<'_>` lifetime issues after `.await` points in Rust | ✓ Good — required for clone_project / create_new_project |
| `connection_id` threaded through git IPC commands | Same dialogs work for local and SSH remote projects | ✓ Good — caught in human-verify checkpoint |
| Dual-dialog visibility: `open={open && !showDirPicker}` | Preserves form state while sub-dialog (FilePicker) is open | ✓ Good — form not unmounted on sub-dialog open |
| Create dialog inline errors; Clone dialog toast errors | Create failures are user-fixable (dir exists); Clone failures are server-side | ✓ Good — right UX for each error class |

---
*Last updated: 2026-03-30 after Phase 28 (zombie-cleanup-on-project-open) completion — v1.3 milestone complete*
