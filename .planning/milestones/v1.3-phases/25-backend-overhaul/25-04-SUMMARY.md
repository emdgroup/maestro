---
phase: 25-backend-overhaul
plan: "04"
subsystem: backend
tags: [execution, worktrees, ipc, bindings, typescript]
dependency_graph:
  requires: [25-01, 25-03]
  provides: [on-demand worktree lifecycle, list_executions_with_task_info IPC, regenerated bindings]
  affects: [src-tauri/src/ipc/execution_handlers.rs, src-tauri/src/lib.rs, src/types/bindings.ts]
tech_stack:
  added: []
  patterns: [on-demand worktree create/delete, SQL join view model, tauri-specta binding generation]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
decisions:
  - spawn_agent_execution and resume_agent_execution call create_worktree_for_task at entry and delete_worktree_for_task in finalization block; error paths delete DB row best-effort via DELETE FROM worktrees
  - list_executions_with_task_info uses LEFT JOIN worktrees so executions with no active worktree still appear (worktree deleted after completion)
  - sidecar path hardcoded as "sidecar/dist/index.js" matching existing review_handlers pattern
metrics:
  duration: 0.086h
  completed: "2026-03-29"
  tasks_completed: 2
  files_modified: 3
---

# Phase 25 Plan 04: Complete Backend Overhaul — Execution Handlers & Bindings Summary

On-demand worktree lifecycle fully wired into spawn/resume execution handlers; list_executions_with_task_info IPC command added; TypeScript bindings regenerated with WorktreeWithStatus and ExecutionWithTask.

## Tasks Completed

### Task 1: Migrate execution_handlers.rs to on-demand worktree lifecycle

**Commit:** ab31467

Replaced `todo!()` stubs in `spawn_agent_execution` and `resume_agent_execution` with full implementations:

- Both handlers call `super::create_worktree_for_task()` at the start (on-demand creation)
- Both finalization blocks call `super::delete_worktree_for_task()` on completion
- Error paths use `DELETE FROM worktrees WHERE id = ?` best-effort cleanup (no pool "Dirty" status)
- Added `list_executions_with_task_info` — synchronous IPC command returning `Vec<ExecutionWithTask>` via SQL join across execution_logs, tasks, and worktrees tables
- Added `use crate::models::ExecutionWithTask` import at top of file

No pool references remain (`lease_worktree`, `status = 'Available'`, `status = 'Dirty'` all absent).

### Task 2: Update lib.rs command registration and regenerate TypeScript bindings

**Commit:** c4eec0e

- Added `crate::ipc::list_executions_with_task_info` to `collect_commands!` in lib.rs
- 5 new commands now registered: `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`, `list_executions_with_task_info`
- 6 pool commands already removed in Plans 01/02 (verified 0 references remain)
- `pnpm tauri:gen` succeeded — bindings.ts regenerated with `WorktreeWithStatus` and `ExecutionWithTask`
- `pnpm build` passes with 0 TypeScript errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed spawn_agent_cli call signature**

- **Found during:** Task 1
- **Issue:** Plan's proposed implementation called `spawn_agent_cli(working_dir, task_id, log_id)` but the actual function signature is `spawn_agent_cli(working_dir, sidecar_path, task_id)`
- **Fix:** Added `"sidecar/dist/index.js"` as second argument (matching existing pattern in review_handlers.rs), removed `log_id` from call
- **Files modified:** src-tauri/src/ipc/execution_handlers.rs
- **Commit:** ab31467

**2. [Deviation — already done] Pool commands removed in prior plans**

- The plan expected to find and remove 6 pool commands from lib.rs, but Plans 01/02 already removed them
- lib.rs already had `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree` registered
- Only `list_executions_with_task_info` needed to be added (Plan 04's new command)

## Known Stubs

None — all implementations are complete. The `spawn_agent_execution` and `resume_agent_execution` handlers are fully implemented (no more `todo!()` macros).

## Phase 25 Completion Status

Phase 25 (backend-overhaul) is now COMPLETE:
- Plan 01: Schema migration, WorktreeWithStatus/ExecutionWithTask models
- Plan 02: Git module (list_worktrees_local, get_worktree_status_local, create_worktree, delete_worktree)
- Plan 03: worktree_handlers.rs (5 IPC commands + create_worktree_for_task/delete_worktree_for_task helpers)
- Plan 04: execution_handlers.rs migration + lib.rs registration + bindings.ts regeneration

Phases 26 (Worktrees View) and 27 (Agents View) are now unblocked.

## Self-Check: PASSED

- [x] src-tauri/src/ipc/execution_handlers.rs — modified, committed ab31467
- [x] src-tauri/src/lib.rs — modified, committed c4eec0e
- [x] src/types/bindings.ts — regenerated, committed c4eec0e
- [x] `cargo build` exits 0
- [x] `pnpm tauri:gen` exits 0
- [x] `pnpm build` exits 0
- [x] grep pool commands in lib.rs = 0
- [x] WorktreeWithStatus in bindings.ts = 2 matches
- [x] ExecutionWithTask in bindings.ts = 2 matches
- [x] PoolStatus in bindings.ts = 0 matches
