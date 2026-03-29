# Feature Landscape: Agents & Worktrees Management Views (v1.3)

**Domain:** Agent monitoring UI + git worktree management UI for an existing Tauri 2 + React 19 desktop app
**Researched:** 2026-03-29
**Overall confidence:** HIGH (verified against xterm.js official docs, git-worktree man page, VS Code worktree docs; supplemented by pattern analysis of existing codebase)

---

## Context: What Already Exists

This research targets **v1.3 specifically**. The following is already shipped and must not be rebuilt:

- `TerminalComponent` — full xterm.js integration with FitAddon, PTY attach/detach, resize, input forwarding
- `ExecutionHistory` — logs query, search, status badges, retry/cancel, error details display
- `ExecutionLog` model — `{id, task_id, status, started_at, completed_at, terminal_output, error_event}`
- `Worktree` model — `{id, project_id, branch_name, path, status, leased_at, returned_at, created_at}`
- `WorktreeStatus` enum — `Available | Leased | InUse | Dirty`
- Git module — `create_worktree`, `delete_worktree`, `git_diff`, `git_status`, `list_branches` (local stubs + remote SSH implementations)
- IPC — `lease_worktree`, `return_worktree`, `get_pool_status`, `cleanup_worktree`, `recover_dirty_worktrees`, `initialize_worktree_pool`
- `navigationStore` — deep linking to agents and worktrees by entity ID
- TanStack Query service layer — all IPC wrapped in query/mutation hooks

The placeholder `AgentMonitor` shows a static sidebar + fake terminal output. The placeholder `WorktreeManager` shows hard-coded cards. Both are purely presentational with no real data.

---

## Table Stakes

Features users expect. Missing any of these makes the view feel broken or pointless.

### Agents View Table Stakes

| Feature | Why Expected | Complexity | Dependency on Existing |
|---------|--------------|------------|----------------------|
| **Execution list with real data** | Sidebar claiming "Agents" but showing static items is trust-destroying. Users need to see actual running/historical executions from the DB. | LOW | `useExecutionLogsQuery` exists per-task; need new `useAllExecutionLogsQuery` across project |
| **Live xterm.js terminal for selected agent** | The entire point of an agents view is to see what an agent is doing right now. `TerminalComponent` already works; it just isn't wired to the agents view. | LOW | `TerminalComponent` is fully functional — wire task ID from selected execution |
| **Status indicators (running / paused / failed / done)** | `ExecutionStatus` enum already defined. Users need to see status at a glance without opening terminal. | LOW | `ExecutionStatus` model and status color logic already in `ExecutionHistory` |
| **Elapsed time for active executions** | Terminal multiplexers (tmux, WezTerm) all show elapsed time. Users need to know "how long has this been running?" | LOW | `started_at` field exists on `ExecutionLog`; calculate client-side with interval |
| **Task name / link for each execution** | An execution without task context is meaningless. Users need to know what task the agent is working on. | LOW | `task_id` on `ExecutionLog` — join with tasks query or enrich on backend |
| **Empty state when no executions** | App with blank sidebar is confusing. Tell users "No active agents — start a task from the Kanban board." | LOW | Pure UI |
| **Auto-select most recent active execution on view open** | When navigating to Agents view, default selection should be the most interesting item (running > paused > most recent). | LOW | Deep linking via `navigationStore.pendingAgentId` already wired; add fallback logic |
| **Graceful handling when terminal PTY is dead** | Agent may have completed/crashed. Trying to attach to a dead PTY must not hang or crash. Show "Session ended" with final output from `terminal_output` field. | MEDIUM | `TerminalComponent` calls `attachTerminal` — need dead session detection in IPC |

### Worktrees View Table Stakes

| Feature | Why Expected | Complexity | Dependency on Existing |
|---------|--------------|------------|----------------------|
| **Real git worktree list from `git worktree list --porcelain`** | Placeholder shows hard-coded cards. Real view must reflect actual filesystem state, not DB records alone. | MEDIUM | `git_status` and `list_branches` local stubs exist but are unimplemented — need `list_worktrees` IPC command returning porcelain parse result |
| **Branch name per worktree** | `git worktree list --porcelain` gives `branch refs/heads/name` — always shown as primary identifier. | LOW | Part of `list_worktrees` IPC |
| **Dirty / clean status per worktree** | Users must know which worktrees have uncommitted changes. `git status --short` on each worktree path. | MEDIUM | Requires per-path `git status` call in IPC; porcelain format gives HEAD commit but not dirty state |
| **Task link per worktree** | Worktree exists to serve a task. Show which task it belongs to (from DB). Without this the worktree list has no meaning in the orchestration context. | LOW | DB join: `worktrees.branch_name` → pattern match against task-linked branch naming |
| **Agent status badge** | Is an agent currently running in this worktree? Users need to see "active" vs "idle" per worktree. | LOW | Join `execution_logs` where `status = running` AND `task_id` matches worktree's task |
| **Last activity timestamp** | `created_at` + `leased_at` already on Worktree model. Show human-readable relative time. | LOW | Already in model — format client-side |
| **Right-panel detail with git diff vs base branch** | VS Code shows diffs per worktree. `DiffViewer` component exists. Users reviewing worktree state need to see what changed. | MEDIUM | `git_diff` function exists in `git/mod.rs` — need IPC wrapper `get_worktree_diff(worktree_id)` |
| **Delete worktree action** | `cleanup_worktree` IPC already exists. Users must be able to remove stale worktrees from the UI. | LOW | IPC exists; add confirmation dialog |
| **Zombie / prunable detection badge** | `git worktree list --porcelain` surfaces `prunable` flag for worktrees whose paths no longer exist on disk. Must show prominently. | MEDIUM | Parse porcelain output; detect `prunable` annotation; show warning badge |
| **Empty state** | "No worktrees — agents create them automatically when tasks start." | LOW | Pure UI |

---

## Differentiators

Features that elevate the experience beyond basic functionality.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Search / filter execution list** | Multiple concurrent agents means long lists. Filter by status (running, paused, failed) or task name. `ExecutionHistory` already has search for terminal output — replicate the pattern at list level. | LOW | Client-side filter on `executions` array |
| **Uncommitted file count in worktree card** | Show "+3 files changed" inline on card (not just dirty/clean). Users can triage without opening detail panel. | MEDIUM | `git diff --stat` on worktree path in IPC |
| **One-click "Force cleanup" for zombie worktrees** | When a worktree is marked `prunable`, show action button to run `git worktree prune` + remove DB record. No modal needed — user already sees zombie badge. | MEDIUM | New `prune_worktrees(project_id)` IPC command |
| **Resume/retry action inline in agent list** | When status is `paused` or `failed`, show retry button directly in sidebar row — no need to open terminal or navigate to Kanban. Reduces friction. | MEDIUM | `useResumeExecutionMutation` already exists |
| **Cancel action inline in agent list** | Running executions show a stop button in the sidebar row. Same pattern as above. | LOW | `useDetachTerminalMutation` + `useCancelExecutionMutation` already exist |
| **Worktree card: navigate to linked task** | Each worktree card has a "View Task" link that deep-links to Kanban via `navigationStore.navigate()`. | LOW | `navigationStore` discriminated union already supports task deep linking |
| **Agents view: navigate to linked worktree** | From agent detail, "View Worktree" button deep-links to Worktrees view with that worktree highlighted. | LOW | `navigationStore` supports worktree deep linking |

---

## Anti-Features

Features that seem useful but should explicitly not be built in v1.3.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Multiple terminals side-by-side (split pane)** | Tmux-style split panes are complex (resize coordination, focus management). The sidebar-plus-single-pane pattern is sufficient for monitoring one agent at a time. | Single terminal pane, switch by selecting different agent in sidebar |
| **Terminal tabs within agents view** | Tabs add complexity (tab strip, active state) without adding value over the existing sidebar. | Sidebar IS the tab strip — select row = switch terminal |
| **Worktree creation from the worktrees view** | Creating worktrees in v1.3 is task-driven (agent creates them on task start). Manual creation from this view conflates two distinct workflows and confuses users. Defer to v2 when use case is validated. | Worktrees are created automatically by the execution pipeline |
| **Git operations (merge, push, rebase) in worktrees view** | This is not a git GUI. The review flow already handles merge approval. Adding raw git ops creates overlap and potential for misuse. | Review flow (existing) handles all merge operations |
| **Real-time polling for git status updates** | Polling `git status` on every worktree every N seconds is expensive, especially for remote SSH projects. | Refresh on view open + explicit refresh button; no background polling |
| **xterm.js search within agents view** | `@xterm/addon-search` is valuable but adds implementation complexity. `ExecutionHistory` already has text-based search over `terminal_output` for completed logs. Live terminal search is a low-priority add-on. | Defer; use browser find-in-page as workaround for now |
| **WebGL renderer for xterm.js** | `@xterm/addon-webgl` improves rendering performance but adds GPU dependency. The existing canvas renderer handles Claude Code output volume fine. | Keep default canvas renderer; add WebGL only if perf issues emerge |
| **Agent scheduling / queuing from agents view** | Task management belongs in the Kanban view. Agents view is a monitor, not a dispatcher. | Kanban board is the task dispatcher |

---

## Feature Dependencies

```
[list_worktrees IPC] ← new, blocks all worktree view features
  ├──→ [Worktree card list with real data]
  ├──→ [Dirty/clean status per card]
  ├──→ [Zombie/prunable detection]
  └──→ [get_worktree_diff IPC] ← new, depends on list to know which worktrees exist
        └──→ [Right-panel diff viewer] (reuses existing DiffViewer component)

[list_all_executions IPC] ← new, blocks all agents view data features
  ├──→ [Execution sidebar with real data]
  ├──→ [Status indicators]
  ├──→ [Elapsed time display]
  └──→ [Task name join]
        └──→ [Live terminal attach] (reuses existing TerminalComponent, blocked on execution ID)

[Dead session detection] ← new backend logic, blocks graceful error state in agents view

[prune_worktrees IPC] ← new, enables zombie cleanup action (optional differentiator)
```

### Dependency Notes

- **`list_worktrees` is the critical blocker** for the entire worktrees view. Without parsing real `git worktree list --porcelain` output, all cards are fake. This is Phase 1 of the milestone.
- **`list_all_executions` is the critical blocker** for the entire agents view. The existing `useExecutionLogsQuery` is scoped to a single `task_id`. A project-wide query is needed.
- **`TerminalComponent` is ready** — it's wired for attach, resize, and input. The agents view just needs to select a `task_id` and mount the component. No changes to Terminal.tsx required.
- **`DiffViewer` is ready** — it already renders unified diffs. The worktrees view just needs the diff string from the new IPC command.
- **Deep linking is already wired** — `navigationStore.pendingAgentId` and `pendingWorktreeId` are consumed in `AgentsView.tsx` and `WorktreesView.tsx`. Auto-select logic just needs to respond to these values.
- **Dead session handling** must come before the agents view ships. Attaching to a dead PTY without error handling will crash the view.

---

## MVP Recommendation for v1.3

**Build in this order:**

1. **Backend first: `list_worktrees` IPC** — Runs `git worktree list --porcelain`, parses output, enriches with DB records (task link, agent status). Returns structured `WorktreeDetail` including `branch`, `path`, `head_commit`, `is_prunable`, `is_dirty`, `task_id`, `agent_status`, `last_activity`.

2. **Backend second: `list_all_executions` IPC** — Returns `ExecutionLog[]` for all tasks in a project, enriched with `task_title` from tasks table. Sorts by `started_at DESC`.

3. **Backend third: `get_worktree_diff` IPC** — Wraps existing `git_diff()` function. Takes `worktree_id`, looks up branch from DB, calls `git diff origin/main...<branch> --unified=3`.

4. **Agents view with real data** — Wire sidebar to `list_all_executions`, mount `TerminalComponent` for selected execution's `task_id`, add dead session fallback to show `terminal_output` field as plain text.

5. **Worktrees view with real data** — Wire cards to `list_worktrees`, wire detail panel to `get_worktree_diff` + existing `DiffViewer`, add zombie badge + delete button.

**Defer from v1.3:**
- `prune_worktrees` IPC (zombie batch cleanup) — low priority, manual delete works
- Filter/search on agents view — implement after basic view is functional
- Uncommitted file count (requires `git diff --stat` per worktree — expensive)

---

## Backend Overhaul: Pool Removal

The existing `worktree_handlers.rs` implements a pool-based model with `initialize_worktree_pool`, `lease_worktree`, `return_worktree`. v1.3 replaces this with on-demand creation.

**What changes:**
- Remove `initialize_worktree_pool`, `lease_worktree`, `return_worktree`, `get_pool_status`
- Add `create_worktree_for_task(project_id, task_id, branch_name)` — creates git worktree on disk + DB record
- Keep `cleanup_worktree` — already handles deletion correctly
- Keep `recover_dirty_worktrees` — startup recovery remains important

**Why this matters for feature design:**
- Worktrees view will only show task-linked worktrees (no "Available" pool entries)
- `WorktreeStatus` enum needs update: `Active | Dirty` (remove `Available`, `Leased`, `InUse`)
- Card metadata becomes richer: each worktree always has a task association

---

## Complexity Summary

| Feature | Complexity | Notes |
|---------|------------|-------|
| `list_worktrees` IPC | MEDIUM | Porcelain parsing + DB enrichment; SSH remote must work too |
| `list_all_executions` IPC | LOW | SQL query + join; pattern from existing task handlers |
| `get_worktree_diff` IPC | LOW | Wraps existing `git_diff()` function |
| Dead session detection | MEDIUM | Backend must check if PTY process is still alive |
| Agents sidebar + terminal wiring | LOW | TerminalComponent is ready; just need data |
| Worktrees card grid + detail panel | MEDIUM | Cards need real data; detail needs diff IPC |
| Zombie/prunable badge | LOW | Parse `prunable` from porcelain output |
| Delete worktree UI | LOW | IPC exists; add confirmation dialog |
| Pool removal + on-demand creation | MEDIUM | Refactor worktree_handlers.rs; update DB schema usage |
| Deep link auto-select logic | LOW | pendingAgentId/pendingWorktreeId already wired |

---

## Sources

- xterm.js official docs: https://xtermjs.org/docs/api/terminal/classes/terminal/ (HIGH confidence — official docs)
- xterm.js addon list: https://github.com/xtermjs/xterm.js/tree/master/addons (HIGH confidence — official repo)
- git-worktree porcelain format: https://git-scm.com/docs/git-worktree (HIGH confidence — official man page)
- VS Code worktree UI patterns: https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees (HIGH confidence — official docs)
- Existing codebase analysis: `src/components/execution/Terminal.tsx`, `WorktreeManager.tsx`, `AgentMonitor.tsx`, `ExecutionHistory.tsx`, `src-tauri/src/ipc/worktree_handlers.rs`, `src-tauri/src/models/worktree.rs` (HIGH confidence — direct code inspection)
