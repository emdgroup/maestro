# Phase 30: v1.3 post-testing UI and worktree bug fixes - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix four issues discovered during post-v1.3 testing:
1. AgentsView and WorktreesView need a top-level action bar (same pattern as KanbanView)
2. Agents view needs a "Spawn Agent" button for interactive/task-free agent sessions
3. Executing a task from Kanban fails with "not a git repository" — root cause is a path bug in Rust
4. WorktreeManager's "New Worktree" dialog needs an origin branch dropdown and auto-derived path

No new capabilities beyond these four fixes. Worktrees view and Agents view layout restructuring, one new IPC command (interactive spawn), one Rust bug fix.

</domain>

<decisions>
## Implementation Decisions

### Action bar — layout
- Both AgentsView and WorktreesView get a full-width action bar above the split-pane
- Pattern: `h-12 border-b border-border bg-muted/30 flex items-center px-4 gap-2 shrink-0` — identical to KanbanView
- The split-pane (sidebar + right panel) renders below the action bar via `flex-1 min-h-0 flex`
- The inner sidebar header row ("Agents" / "Worktrees" title) is removed — sidebar goes straight to the list

### Action bar — Agents view contents
- Left slot: search input + status filter toggle group (All / Running / Done / Failed)
- Right slot: "Spawn Agent" button (see below)
- State lifted to `AgentsView`; `AgentMonitor` receives `search` and `statusFilter` as props (keeps pure-display pattern)

### Action bar — Worktrees view contents
- Left slot: search input + status filter toggle group (All / Active / Modified / Idle)
- Right slot: empty (no extra buttons)
- "New Worktree" button stays inside the sidebar (within the worktree list section, not the action bar)
- State lifted to `WorktreesView`; `WorktreeManager` receives `search` and `statusFilter` as props

### Manual agent spawn — model
- Task-free: the spawn does NOT require a task. The agent runs in interactive mode.
- The user selects a branch from a dropdown (populated via `list_project_branches`)
- If a worktree already exists for that branch, reuse it; if not, create `.maestro/worktrees/<branch-name>`
- The agent process starts as an interactive PTY session — no initial instructions. User drives via xterm.js terminal.
- Rust backend: `task_id` becomes `Option<i32>` in a new `spawn_interactive_execution` IPC command (or extend existing spawn to accept `Option<i32>`)

### Manual agent spawn — UX
- "Spawn Agent" button lives in the right slot of the Agents view action bar
- Clicking it opens a dialog: branch dropdown (populated with project branches) + (optional) a label/description field
- After spawning, the new session is auto-selected in the agents list
- The agent entry in the list shows the branch name as the primary identifier (no task name)

### Worktree creation dialog — fields
- Origin branch: dropdown populated from `list_project_branches` (required)
- New branch name: text input, optional — if left blank, use origin branch directly (git worktree add checks out the existing branch, not creating a new one)
- Worktree path: auto-derived as `.maestro/worktrees/<branch-name>` (hidden from UI — computed in backend)
- Error if worktree for that branch already exists: surface error to the user in the dialog

### Worktree creation dialog — git behavior
- When new branch name is provided: `git worktree add .maestro/worktrees/<new-branch> -b <new-branch> <origin-branch>`
- When new branch name is omitted: `git worktree add .maestro/worktrees/<origin-branch> <origin-branch>` (checks out existing branch)
- The IPC command `create_worktree` must be updated to accept `origin_branch: Option<String>` and adjust the git invocation accordingly

### Execution path bug fix
- Fix the root cause in Rust — the `repo_path` passed to `create_worktree_local` is wrong when executing from Kanban
- No upfront `.git` validation — just fix the path so git runs in the right directory
- Likely root cause: investigate whether `currentProject.path` is empty, relative, or the wrong directory for the project in use
- No design change — pure bug fix

### Claude's Discretion
- Exact error message shown in the Create Worktree dialog when branch already exists
- Whether `spawn_interactive_execution` is a new IPC command or an extension of `spawn_agent_execution` with optional task_id
- How the interactive session is displayed in the agents list when no task name exists (use branch name)

</decisions>

<canonical_refs>
## Canonical References

No external specs — requirements are fully captured in decisions above.

Relevant codebase files downstream agents MUST read before planning:
- `src/views/KanbanView.tsx` — action bar pattern to replicate exactly
- `src/views/AgentsView.tsx` — view to restructure
- `src/views/WorktreesView.tsx` — view to restructure
- `src/components/execution/AgentMonitor.tsx` — filter state to lift out
- `src/components/execution/WorktreeManager.tsx` — filter state to lift out; create dialog to replace
- `src-tauri/src/ipc/worktree_handlers.rs` — `create_worktree` IPC and `create_worktree_for_task` internal helper
- `src-tauri/src/ipc/execution_handlers.rs` — `spawn_agent_execution` to understand task_id dependency and the path bug
- `src-tauri/src/git/mod.rs` — `create_worktree_local` where the path bug lives

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `list_project_branches` IPC command: already implemented (Phase 29 quick task) — returns `(Vec<String>, String)` (branches, current branch)
- `useProjectBranchesQuery(projectId)`: already in `task.service.ts` — returns branch list and current branch
- KanbanView action bar markup: `h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0` — copy verbatim
- `ToggleGroup` + `ToggleGroupItem` from `@/ui/toggle-group` — already used in AgentMonitor and WorktreeManager for filters
- `Dialog`, `DialogContent`, `DialogHeader` etc from `@/ui/dialog` — already used in WorktreeManager create dialog

### Established Patterns
- Pure-display component pattern: Views (AgentsView, WorktreesView) own all queries and state; components (AgentMonitor, WorktreeManager) receive everything as props — the new `search` and `statusFilter` props must follow this
- Service layer: all IPC calls go through `api.*` in `*.service.ts`, wrapped in TanStack Query hooks — no direct `invoke()` in components

### Integration Points
- `AgentMonitor` props expand: add `search: string`, `statusFilter: StatusFilter` — remove internal `useState` for these
- `WorktreeManager` props expand: add `search: string`, `statusFilter: StatusFilter` — remove internal `useState` for these
- New interactive spawn IPC needs to be registered in `lib.rs` and regenerate bindings (`pnpm tauri:gen`)
- `create_worktree` IPC signature changes: replace `branch_name: String` with `origin_branch: String, new_branch: Option<String>`; `worktree_path: Option<String>` becomes computed-only (remove from caller)

### Path bug investigation starting point
- `create_worktree_for_task` in `worktree_handlers.rs` receives `repo_path: &str` from `spawn_agent_execution`
- `spawn_agent_execution` IPC receives `repo_path: String` from frontend
- Frontend: `boardStore.ts` calls `api.spawnAgentExecution(projectId, taskId, repoPath)` where `repoPath = projectPath` from `KanbanContext`
- `KanbanContext.projectPath` = `currentProject.path` from `App.tsx`
- Investigate: is `currentProject.path` ever empty, or is it a relative path that doesn't resolve from the Tauri process's working directory?

</code_context>

<specifics>
## Specific Ideas

- Action bar in Agents view: "Spawn Agent" button on the right slot (mirroring the KanbanView sub-view switcher position)
- Spawn Agent dialog: branch dropdown + optional description/label
- After spawn, auto-select the new session in the list
- Agents list entry with no task: show branch name as the primary identifier instead of task name

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 30-v1-3-post-testing-ui-and-worktree-bug-fixes*
*Context gathered: 2026-03-30*
