# Architecture Research: Agents + Worktrees Views with Backend Overhaul

**Domain:** Tauri 2 desktop app — real-time agent monitoring, on-demand worktree management
**Researched:** 2026-03-29
**Confidence:** HIGH (full codebase read, all integration points verified in source)

---

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         React 19 View Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  AgentsView  │  │WorktreesView │  │  KanbanView  │  (existing)    │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘               │
│         │                  │                                          │
├─────────┴──────────────────┴─────────────────────────────────────────┤
│                       Component Layer                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ AgentMonitor │  │WorktreeMgr   │  │ExecutionTerm │  (rewritten)   │
│  │ (real data)  │  │ (real data)  │  │  (xterm.js)  │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                  │                  │                       │
├─────────┴──────────────────┴──────────────────┴──────────────────────┤
│                    Service / TanStack Query Layer                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │execution.svc │  │ worktree.svc │  │  Tauri Chan  │  (new/extend)  │
│  │  useQuery()  │  │  useQuery()  │  │  PTY stream  │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                  │                  │                       │
├─────────┴──────────────────┴──────────────────┴──────────────────────┤
│                   Tauri IPC Boundary (invoke)                         │
├─────────────────────────────────────────────────────────────────────┤
│                        Rust Backend                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  execution_  │  │  worktree_   │  │   git/       │               │
│  │  handlers.rs │  │  handlers.rs │  │   mod.rs     │               │
│  │  (existing + │  │  (rewritten) │  │  (existing)  │               │
│  │   new cmds)  │  │              │  │              │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                  │                  │                       │
│  ┌──────┴───────────────────┴──────────────────┴──────────────┐      │
│  │                   AppState (Arc<AppState>)                   │      │
│  │   db: Mutex<Connection>  |  pty_sessions: HashMap           │      │
│  │   ssh_sessions: HashMap  |  ssh_passwords: HashMap          │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                         SQLite (schema v3)                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Status |
|-----------|----------------|--------|
| `AgentsView` | Page orchestrator; consumes `pendingAgentId` from navigationStore | Exists — wire to real data |
| `AgentMonitor` | Sidebar execution list + xterm.js terminal pane | Rewrite from placeholder |
| `WorktreesView` | Page orchestrator; consumes `pendingWorktreeId` from navigationStore | Exists — wire to real data |
| `WorktreeManager` | Card grid + right detail panel with git diff | Rewrite from placeholder |
| `execution.service.ts` | TanStack Query hooks for execution logs and PTY ops | Extend with list/query hooks |
| `worktree.service.ts` | TanStack Query hooks for worktree CRUD and diff | New file |
| `worktree_handlers.rs` | IPC commands for listing, creating, deleting worktrees | Full rewrite |
| `execution_handlers.rs` | IPC commands for execution + terminal streaming | Extend with list hook |
| `models/worktree.rs` | Worktree Rust struct | Overhaul (remove pool fields, add task_id) |

---

## Integration Points: New vs Modified

### New IPC Commands (Rust)

These commands do not exist today and must be added to `worktree_handlers.rs` (or a new handler file) and registered in `lib.rs`:

| Command | Signature | Purpose |
|---------|-----------|---------|
| `list_worktrees_with_status` | `(project_id: i32) -> Vec<WorktreeWithStatus>` | Full worktree listing with task name, branch, git_status fields for the view |
| `get_worktree_diff` | `(project_id: i32, worktree_id: i32) -> String` | Raw unified diff for selected worktree (feeds `@git-diff-view/react`) |
| `create_worktree` | `(project_id: i32, task_id: i32, branch_name: String) -> Worktree` | On-demand worktree creation; replaces pool allocation in spawn path |
| `delete_worktree` | `(project_id: i32, worktree_id: i32) -> ()` | Delete worktree + branch; replaces `cleanup_worktree` in manual flow |
| `list_executions_with_task_info` | `(project_id: i32) -> Vec<ExecutionWithTask>` | All executions for the Agents sidebar, joined with task name + status |

### Modified IPC Commands (Rust)

| Command | Current Behavior | Change |
|---------|-----------------|--------|
| `spawn_agent_execution` | Calls `lease_worktree()` (pool) | Replace lease call with `create_worktree()` on-demand; worktree created fresh per execution |
| `resume_agent_execution` | Calls `lease_worktree()` (pool) | Same change — on-demand worktree |
| `cleanup_worktree` | Returns worktree to pool as Available | Delete worktree entirely instead; no pool return |

### Commands to Remove (Rust)

These become dead code once pool logic is gone:

| Command | Reason |
|---------|--------|
| `lease_worktree` | Pool concept removed |
| `return_worktree` | Pool concept removed |
| `get_pool_status` | Pool concept removed |
| `initialize_worktree_pool` | Pool concept removed |
| `recover_dirty_worktrees` | Replace with simpler zombie cleanup on startup |

### New Frontend Services

| File | Hooks | Purpose |
|------|-------|---------|
| `src/services/worktree.service.ts` | `useWorktreesQuery`, `useWorktreeDiffQuery`, `useCreateWorktreeMutation`, `useDeleteWorktreeMutation` | All worktree UI data needs |
| `src/services/execution.service.ts` (extend) | `useExecutionsWithTaskInfoQuery` | Agent sidebar list data |

---

## Rust Model Changes

### Worktree Model Overhaul

**Current `models/worktree.rs`:**
```rust
pub enum WorktreeStatus { Available, Leased, InUse, Dirty }
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub branch_name: String,
    pub path: String,
    pub status: WorktreeStatus,       // pool lifecycle — remove
    pub leased_at: Option<String>,    // pool lifecycle — remove
    pub returned_at: Option<String>,  // pool lifecycle — remove
    pub created_at: String,
}
```

**Recommended `models/worktree.rs` after overhaul:**
```rust
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub task_id: Option<i32>,         // FK to task currently using this worktree
    pub branch_name: String,
    pub path: String,
    pub git_status: String,           // "clean" | "dirty" | "unknown"
    pub is_zombie: bool,              // no live PTY session + no active task
    pub created_at: String,
}

// New view model — returned by list_worktrees_with_status
pub struct WorktreeWithStatus {
    pub worktree: Worktree,
    pub task_name: Option<String>,    // joined from tasks table
    pub execution_status: Option<ExecutionStatus>,
    pub last_commit_hash: Option<String>,
    pub last_commit_message: Option<String>,
    pub uncommitted_file_count: i32,
}
```

**New execution view model — returned by list_executions_with_task_info:**
```rust
pub struct ExecutionWithTask {
    pub log: ExecutionLog,
    pub task_id: i32,
    pub task_name: String,
    pub task_status: TaskStatus,
}
```

### Database Schema Change (v3)

The `worktrees` table needs migration:

```sql
-- Remove pool columns, add task_id FK and git_status
ALTER TABLE worktrees DROP COLUMN status;
ALTER TABLE worktrees DROP COLUMN leased_at;
ALTER TABLE worktrees DROP COLUMN returned_at;
ALTER TABLE worktrees ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE worktrees ADD COLUMN git_status TEXT NOT NULL DEFAULT 'unknown';
```

Increment `SCHEMA_VERSION` to 3 in `db/schema.rs`. Because there is no production data yet (app not publicly released), the existing schema migration pattern — drop all tables and recreate — is the correct approach.

---

## Data Flow: Real-Time Execution Status

### Pattern: TanStack Query Polling for Execution List

The Agents sidebar (execution list) does not need a Tauri event channel. It needs a list that refreshes when executions change. Use TanStack Query with a short `refetchInterval`:

```
User opens Agents tab
    → useExecutionsWithTaskInfoQuery(projectId, { refetchInterval: 2000 })
    → invoke("list_executions_with_task_info", { projectId })
    → Rust: JOIN execution_logs + tasks, return Vec<ExecutionWithTask>
    → Component renders sidebar list, auto-refreshes every 2s
```

The 2-second poll is sufficient because execution state changes are infrequent (seconds-long transitions) and SQLite reads are fast. A Tauri event channel for status updates would add complexity without meaningful benefit here.

### Pattern: Tauri Channel for PTY Terminal Output

The live terminal pane uses the existing `attach_terminal` / `detach_terminal` commands and a `Channel<String>` — this pattern already works and does not change. The new `AgentMonitor` component reuses `ExecutionTerminal` (which already wraps xterm.js) unchanged.

```
User selects execution in sidebar
    → component calls useAttachTerminalMutation({ taskId, outputChannel })
    → Rust streams PTY bytes over Tauri channel
    → xterm.js Terminal receives chunks via onmessage handler
    → On sidebar selection change: detach old channel, attach new one
```

**Key constraint:** PTY sessions are keyed by `task_id` in `AppState.pty_sessions`. The Agents view must translate "execution selected" into `task_id` (available on `ExecutionLog.task_id`). No change to the PTY session key needed.

### Pattern: On-Demand Worktree Creation in spawn_agent_execution

```
User clicks "Run" on task
    → useSpawnExecutionMutation({ projectId, taskId, repoPath })
    → invoke("spawn_agent_execution")
    → Rust: create execution log
    → Rust: invoke create_worktree(project_id, task_id, branch_name)
        → git::create_worktree(conn, branch, worktree_name)  [already exists in git/mod.rs]
        → INSERT into worktrees with task_id FK
    → Rust: spawn PTY, store session
    → On completion/failure: DELETE from worktrees (not return to pool)
```

The `git::create_worktree` function in `git/mod.rs` already has the dispatcher pattern for local vs remote. The local implementation is currently a TODO stub — it must be implemented as part of v1.3 backend work.

### Pattern: Git Diff at IPC Call Time (Synchronous)

Git diff computation happens synchronously when `get_worktree_diff` is called. No background job needed:

```
User selects worktree card
    → useWorktreeDiffQuery(projectId, worktreeId)
    → invoke("get_worktree_diff", { projectId, worktreeId })
    → Rust: lookup worktree path + branch_name from DB
    → Rust: call git::git_diff(conn, branch, "main")  [already exists in git/mod.rs]
    → Return unified diff string
    → Frontend: pass to @git-diff-view/react (already used in review flow)
```

This is synchronous per-request rather than background-computed because:
- Diff size is bounded (agent branches are typically small)
- The existing `git::git_diff` dispatcher already handles local + remote
- A background cache would add state management complexity without clear benefit

---

## Recommended Project Structure Changes

### Frontend

```
src/
├── components/
│   └── execution/
│       ├── AgentMonitor.tsx        # REWRITE: real data, xterm.js terminal pane
│       ├── WorktreeManager.tsx     # REWRITE: real data, diff detail panel
│       ├── ExecutionTerminal.tsx   # keep — xterm.js wrapper, reuse in AgentMonitor
│       ├── DiffViewer.tsx          # keep — used by WorktreeManager detail panel
│       ├── Terminal.tsx            # keep
│       ├── ExecutionHistory.tsx    # keep
│       └── FileTree.tsx            # keep
├── services/
│   ├── execution.service.ts        # EXTEND: add useExecutionsWithTaskInfoQuery
│   └── worktree.service.ts         # NEW: all worktree hooks
└── views/
    ├── AgentsView.tsx              # WIRE: connect to execution.service hooks
    └── WorktreesView.tsx           # WIRE: connect to worktree.service hooks
```

### Backend

```
src-tauri/src/
├── models/
│   └── worktree.rs                 # OVERHAUL: remove pool fields, add task_id + WorktreeWithStatus
├── ipc/
│   ├── worktree_handlers.rs        # REWRITE: remove pool commands, add list/create/delete/diff
│   └── execution_handlers.rs      # EXTEND: add list_executions_with_task_info
├── git/
│   └── mod.rs                      # IMPLEMENT: create_worktree_local, delete_worktree_local, git_diff_local stubs
└── db/
    └── schema.rs                   # MIGRATE: schema v3, worktrees table changes
```

---

## Architectural Patterns

### Pattern 1: View Owns Query, Component Receives Data

**What:** `AgentsView` and `WorktreesView` own their TanStack Query hooks. Child components (`AgentMonitor`, `WorktreeManager`) receive data as props.

**When to use:** Always — this is the established pattern in the codebase. Views are page-level orchestrators; components are display units.

**Trade-offs:** Slight prop drilling. The alternative (components owning queries) creates scattered invalidation logic and harder testing. The existing codebase is consistent on this pattern — don't break it.

### Pattern 2: Tauri Channel Lifecycle Tied to Selection State

**What:** When the user selects a different agent in the sidebar, detach the old terminal channel and attach the new one. Channel is created fresh per selection.

**When to use:** Any time a single terminal pane must display different PTY sessions based on list selection.

**Example pattern:**
```typescript
const prevTaskIdRef = useRef<number | null>(null);

useEffect(() => {
  if (selectedTaskId === prevTaskIdRef.current) return;
  if (prevTaskIdRef.current) detachTerminal(prevTaskIdRef.current);
  if (selectedTaskId) attachTerminal(selectedTaskId, new Channel());
  prevTaskIdRef.current = selectedTaskId;
}, [selectedTaskId]);
```

**Trade-offs:** Creates a new channel object per selection. Acceptable — channels are lightweight. The alternative (keeping one channel and re-pointing it) is not supported by the Tauri channel API.

### Pattern 3: Discriminated Union for Dead Session Handling

**What:** An execution may exist in the database but have no live PTY session (process exited or app restarted). The frontend must handle this gracefully.

**When to use:** When rendering agent cards in the sidebar and when attempting to attach terminal.

**Implementation:** `attach_terminal` already returns `Err("No PTY session for task {}")`. The component should catch this error and show a "Session ended — view history" state rather than an error toast. The `ExecutionStatus` enum (Running / Complete / Failed / Paused / Cancelled) is the source of truth for this state — only `Running` status should attempt PTY attachment.

### Pattern 4: On-Demand Worktree Lifecycle (replaces pool)

**What:** Create exactly one worktree per task execution, delete it when done. No pre-allocation, no pool.

**Lifecycle:**
```
spawn_agent_execution
  → git worktree add .worktrees/task-{id} -b agent/task-{id}
  → INSERT worktrees (task_id={id}, path=..., git_status='clean')
  → PTY spawn in worktree path
  → [execution runs]
  → on complete/error: git worktree remove + branch delete
  → DELETE FROM worktrees WHERE id=...
```

**Trade-offs:** No pre-allocation means slight startup latency per task (git worktree add takes ~200-500ms locally). This is acceptable — the pool pre-creation was premature optimization for an MVP.

---

## Anti-Patterns

### Anti-Pattern 1: Polling the Execution Log for Terminal Output

**What people do:** Use `useQuery` with `refetchInterval` on `get_execution_logs` to get `terminal_output` text and display it in a div.

**Why it's wrong:** `terminal_output` is a TEXT column in SQLite that grows continuously. Polling it causes the entire blob to be fetched and re-rendered on every interval. xterm.js is designed to receive incremental chunks via the Tauri channel, not full replays.

**Do this instead:** Use the Tauri channel (`attach_terminal`) for live streaming. For dead sessions (execution completed), fetch `terminal_output` once via `get_execution_logs` and write it to xterm.js on mount with `terminal.write(history)`. The `attach_terminal` command already supports `include_history: true` for this exact use case.

### Anti-Pattern 2: Placing New IPC Commands in a New Handler File

**What people do:** Create `src-tauri/src/ipc/worktree_v2_handlers.rs` to avoid touching the existing worktree handler.

**Why it's wrong:** The existing `worktree_handlers.rs` exports pool commands that will be removed. Splitting into a new file leaves dead code in the old file and muddles the module structure.

**Do this instead:** Rewrite `worktree_handlers.rs` in place. Remove all pool commands, add the new list/create/delete/diff commands. Update `lib.rs` command registration to match.

### Anti-Pattern 3: Deriving WorktreeWithStatus in the Frontend

**What people do:** Fetch `get_tasks`, `get_execution_logs`, and `list_worktrees` separately, then join them in React state.

**Why it's wrong:** Three round-trip IPC calls on every refresh interval. Joining in JS forces extra state management. The backend can do this join cheaply in SQLite.

**Do this instead:** Add `list_worktrees_with_status` and `list_executions_with_task_info` as joined queries on the backend. Single IPC call per view, no frontend join logic.

### Anti-Pattern 4: Keying PTY Sessions by Execution Log ID

**What people do:** Store PTY sessions by `exec_log_id` instead of `task_id`.

**Why it's wrong:** The existing system keys by `task_id` throughout (`AppState.pty_sessions: HashMap<i32, ...>`, `attach_terminal(task_id, ...)`). Changing the key breaks the entire attach/detach/input flow.

**Do this instead:** Keep `task_id` as the PTY session key. The Agents sidebar must track `task_id` (available on `ExecutionLog.task_id`), not `execution_log_id`.

---

## Build Order (Phase Recommendations)

The dependency graph drives this order. Each phase produces a working, testable increment.

### Phase 1: Backend Model Overhaul (no frontend changes)

**Goal:** Remove pool model, introduce on-demand worktree model. Schema v3.

**What changes:**
- Bump `SCHEMA_VERSION` to 3
- Drop pool columns from `worktrees` table, add `task_id` FK and `git_status`
- Overhaul `models/worktree.rs` (remove `WorktreeStatus`, `PoolStatus`; add `WorktreeWithStatus`, `ExecutionWithTask`)
- Implement `create_worktree_local` and `delete_worktree_local` stubs in `git/mod.rs` using `std::process::Command` for `git worktree add/remove`
- Rewrite `worktree_handlers.rs`: remove 5 pool commands, add `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`, `list_executions_with_task_info`
- Modify `spawn_agent_execution` and `resume_agent_execution` to call `create_worktree` on-demand
- Update `lib.rs` command registration
- Run `pnpm tauri:gen` to regenerate `bindings.ts`

**Dependency:** None. Frontend still works because view components use placeholder data.

**Risk:** Schema migration drops all worktrees rows — safe since no production data.

### Phase 2: Agents View — Real Data

**Goal:** Replace `AgentMonitor` placeholder with real execution list and live terminal.

**What changes:**
- Add `useExecutionsWithTaskInfoQuery(projectId)` to `execution.service.ts`
- Rewrite `AgentMonitor.tsx`: sidebar list driven by `ExecutionWithTask[]`, terminal pane using existing `ExecutionTerminal` (xterm.js)
- Wire `AgentsView.tsx` to new hooks, pass data to `AgentMonitor`
- Handle dead session gracefully (status !== Running → show history, no PTY attach attempt)
- Search/filter execution list in component

**Dependency:** Phase 1 (needs `list_executions_with_task_info` IPC command).

### Phase 3: Worktrees View — Real Data

**Goal:** Replace `WorktreeManager` placeholder with real worktree grid and diff detail panel.

**What changes:**
- Create `worktree.service.ts` with all worktree hooks
- Rewrite `WorktreeManager.tsx`: card grid from `WorktreeWithStatus[]`, right panel with `@git-diff-view/react` diff display (already used in review flow)
- Add create worktree dialog and delete confirmation
- Wire `WorktreesView.tsx` to new hooks
- Zombie detection: worktree with `is_zombie: true` shown with warning state and cleanup action

**Dependency:** Phase 1 (needs `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`).

### Phase 4: Worktree Zombie Cleanup on Startup

**Goal:** Detect and clean up orphaned worktrees on project open.

**What changes:**
- On project open (in `App.tsx` `useEffect`): call new `cleanup_zombie_worktrees(projectId)` command
- Rust: find worktrees where `task_id IS NULL` or task status is Done/Archived, attempt `git worktree remove` for each
- This replaces the old `recover_dirty_worktrees` pattern with a simpler, semantically correct one

**Dependency:** Phase 1 and 3.

---

## Integration Points Summary

| Boundary | Before v1.3 | After v1.3 |
|----------|------------|------------|
| Worktree allocation | `lease_worktree` (pool) in spawn path | `create_worktree` (on-demand) in spawn path |
| Worktree cleanup | `return_worktree` (pool) + `cleanup_worktree` | `delete_worktree` (destroy) |
| Agents sidebar data | Placeholder mock data in component | `list_executions_with_task_info` IPC + TanStack Query 2s interval |
| Terminal pane | Static text, no xterm.js | `attach_terminal` Tauri channel → existing xterm.js `ExecutionTerminal` |
| Worktrees grid data | Placeholder mock data in component | `list_worktrees_with_status` IPC + TanStack Query |
| Worktree diff | None | `get_worktree_diff` IPC → `@git-diff-view/react` |
| DB schema | v2 (pool columns) | v3 (task_id FK, git_status column) |
| TypeScript bindings | `WorktreeStatus`, `PoolStatus` exported | `WorktreeWithStatus`, `ExecutionWithTask` exported |

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Rust model changes | HIGH | Full source read; pool pattern fully understood; changes are straightforward |
| IPC command surface | HIGH | All commands read; `lib.rs` registration confirmed; `git/mod.rs` dispatch pattern understood |
| Frontend service hooks | HIGH | `execution.service.ts` pattern is consistent; `worktree.service.ts` follows exact same shape |
| xterm.js + Tauri channel | HIGH | `attach_terminal` + `ExecutionTerminal` already exist and work; reuse is additive |
| Git diff integration | HIGH | `@git-diff-view/react` already used in review flow; `get_worktree_diff` follows `get_diff_for_review` pattern |
| `create_worktree_local` implementation | MEDIUM | `git::create_worktree_local` is currently a stub (TODO comment). Needs `tokio::process::Command` implementation for `git worktree add`. Remote path works (`remote.rs` already handles it). Low risk but requires testing. |
| Schema migration safety | HIGH | No production data; existing migration pattern (drop + recreate) confirmed in `schema.rs` |

---

## Open Questions

1. **`git worktree add` path convention:** Should worktrees be created at `.worktrees/task-{id}` relative to repo root, or in a system temp dir? The old pool used `.worktree-pool/wt-{n}`. Recommend `.worktrees/agent-task-{id}` inside the repo for consistency with the existing git operations.

2. **Remote worktree creation timing:** `spawn_agent_execution` is async and runs worktree creation before spawning the PTY. For remote SSH projects, `create_worktree` calls `remote::create_remote_worktree` which involves SSH I/O. This is fine — the existing lease step was also async. No architectural change needed, but worth a note in the phase plan.

3. **`list_worktrees_with_status` git_status field:** Computing `git_status` requires running `git status --porcelain` per worktree at query time. For many worktrees this could be slow. For v1.3 MVP, compute it per-query. If performance becomes a concern in v2, cache it in the DB and update on a background interval.

---

*Architecture research for: Maestro v1.3 Agents + Worktrees views with backend overhaul*
*Researched: 2026-03-29*
