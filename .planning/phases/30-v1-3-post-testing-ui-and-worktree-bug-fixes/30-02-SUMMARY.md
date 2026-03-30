---
phase: 30-v1-3-post-testing-ui-and-worktree-bug-fixes
plan: "02"
subsystem: backend-ipc + frontend-services
tags: [rust, tauri, ipc, schema, worktree, execution, interactive-session, typescript]
dependency_graph:
  requires: ["30-01"]
  provides: ["spawn_interactive_execution IPC", "schema-v4", "origin+new-branch worktree creation", "nullable task_id"]
  affects: ["AgentsView", "WorktreesView", "execution_logs table"]
tech_stack:
  added: []
  patterns:
    - "nullable execution_logs.task_id for task-free interactive PTY sessions"
    - "origin_branch + optional new_branch_name worktree creation pattern"
    - "execution.id as unified selection key in AgentMonitor (handles null task_id)"
key_files:
  created: []
  modified:
    - src-tauri/src/db/schema.rs
    - src-tauri/src/git/mod.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/models/worktree.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/services/worktree.service.ts
    - src/services/execution.service.ts
    - src/components/execution/WorktreeManager.tsx
    - src/components/execution/AgentMonitor.tsx
    - src/views/AgentsView.tsx
decisions:
  - "Schema V4: execution_logs.task_id made nullable (inline FK, no NOT NULL) to support interactive sessions; drop-and-recreate migration strategy is sufficient since no production data"
  - "create_worktree IPC now takes origin_branch + optional new_branch_name; backend auto-derives worktree path (removes caller burden of supplying worktree_path)"
  - "spawn_interactive_execution uses log_id as PTY session key (not task_id) since there is no task; stored in app_state.pty_sessions under log_id"
  - "AgentMonitor selection key changed from task_id to execution.id to handle null task_id; PTY session key = task_id ?? execution.id"
metrics:
  duration: "0.313h"
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 12
---

# Phase 30 Plan 02: Backend IPC Updates — Schema V4, Interactive Execution, New Worktree Signature

Schema migration to V4 (nullable task_id in execution_logs), new create_worktree signature (origin_branch + new_branch_name), spawn_interactive_execution IPC for task-free agent sessions, and matching frontend service hooks.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Rust backend — schema V4, git/mod.rs, worktree_handlers, execution_handlers, models, bindings | 121b565 |
| 2 | Frontend service hooks + AgentMonitor/AgentsView nullable task_id fix | 6166385 |

## What Was Built

### Schema V4 (src-tauri/src/db/schema.rs)
- Bumped `SCHEMA_VERSION` from 3 to 4
- `execution_logs.task_id` changed from `INTEGER NOT NULL` with separate `FOREIGN KEY` clause to `INTEGER REFERENCES tasks(id) ON DELETE CASCADE` (inline nullable FK)
- Renamed `SCHEMA_V3` constant to `SCHEMA_V4`
- Updated test assertion from `assert_eq!(version, 3)` to `assert_eq!(version, 4)`

### Updated git/mod.rs
- `create_worktree` public dispatcher now accepts `new_branch: Option<&str>`
- `create_worktree_local`: `Some(name)` → `git worktree add {path} -b {name} {branch}` (create new branch from origin); `None` → `git worktree add {path} {branch}` (checkout existing branch)

### Updated worktree_handlers.rs
- `create_worktree` IPC signature: `origin_branch: String, new_branch_name: Option<String>` (replaces `branch_name: String, worktree_path: Option<String>`)
- Branch name for DB = `new_branch_name.unwrap_or(origin_branch.clone())`
- Relative path auto-derived: task-scoped → `worktree_path_for_task(tid)`; task-free → `{WORKTREE_DIR}/{branch_name}`
- `create_worktree_for_task` updated to pass `Some(&branch_name)` and uses `"HEAD"` as base

### New spawn_interactive_execution IPC (src-tauri/src/ipc/execution_handlers.rs)
- Accepts `project_id, branch_name, repo_path, label: Option<String>`
- Checks for existing worktree with same branch; creates one (checkout existing) if absent
- Inserts `execution_logs` row with `task_id = NULL`
- Spawns PTY session keyed by `log_id` in `app_state.pty_sessions`
- Returns `log_id` to caller (used as session key for `attach_terminal`)
- Registered in `collect_commands!` in lib.rs

### Updated ExecutionWithTask model
- `task_id: Option<i32>` (was `i32`)
- `task_name: Option<String>` (was `String`)
- `list_executions_with_task_info` query changed to `LEFT JOIN tasks` with `WHERE t.project_id = ?1 OR (el.task_id IS NULL)`

### Frontend Service Hooks
- `useCreateWorktreeMutation`: params now `{ projectId, taskId, originBranch, newBranchName, repoPath }` (drops `branchName`, `worktreePath`)
- `useSpawnInteractiveExecutionMutation`: new hook in execution.service.ts for task-free sessions

### AgentMonitor + AgentsView (Deviation — Rule 1 auto-fix)
- `AgentMonitor` props changed: `selectedTaskId → selectedExecutionId`, `onSelect` now takes execution.id
- Selection by `execution.id` instead of `task_id` (handles null task_id for interactive sessions)
- PTY session key = `execution.task_id ?? execution.id` (correct for both task-based and interactive sessions)
- `AgentsView` updated to use `selectedExecutionId` state; deep-link matching still finds by task_id then selects by execution.id
- Task name display falls back to `"Interactive"` when task_name is null

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] AgentMonitor used non-nullable task_id fields after model change**
- **Found during:** Task 2 (pnpm build)
- **Issue:** `AgentMonitor.tsx` and `AgentsView.tsx` accessed `execution.task_name` (TS2347 possibly null) and passed `execution.task_id` as `number` (TS2345 null not assignable) after `ExecutionWithTask` fields became `Option`
- **Fix:** Refactored `AgentMonitor` to select by `execution.id` (unified key); PTY key = `task_id ?? id`; task_name display uses `?? "Interactive"`; `AgentsView` uses `selectedExecutionId` instead of `selectedTaskId`
- **Files modified:** `src/components/execution/AgentMonitor.tsx`, `src/views/AgentsView.tsx`
- **Commit:** 6166385

## Known Stubs

None — all wired data flows correctly. `spawn_interactive_execution` uses `claude` as the interactive command; the actual command to launch will be confirmed in plan 03 when the full interactive spawn dialog is built.

## Self-Check: PASSED

- SUMMARY.md: FOUND
- Commit 121b565 (Task 1): FOUND
- Commit 6166385 (Task 2): FOUND
- cargo check: 0 errors
- cargo test test_schema_initialization: PASSED
- pnpm build: 0 TypeScript errors
