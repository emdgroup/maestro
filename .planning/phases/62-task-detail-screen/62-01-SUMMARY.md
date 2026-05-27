---
phase: 62-task-detail-screen
plan: "01"
subsystem: backend-ipc + frontend-service
tags: [rust, ipc, task-management, bindings, tanstack-query]
dependency_graph:
  requires: []
  provides: [update_task_labels_auto_approve_isolated_worktree, cancel_task_ipc, useCancelTaskMutation, useUpdateTask_extended]
  affects: [src/services/task.service.ts, src/types/bindings.ts, src-tauri/src/ipc/task_handlers.rs]
tech_stack:
  added: []
  patterns: [UpdateTaskRequest_struct_for_specta_limit, dynamic_SET_builder_pattern]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/lib.rs
    - src/services/task.service.ts
    - src/types/bindings.ts
decisions:
  - "UpdateTaskRequest struct used instead of positional parameters — specta 2.0.0-rc.22 caps SpectaFn at 10 arguments; 12-arg flat signature would not compile"
  - "cancel_task is a sync fn (not async) matching the archive_task pattern — no session teardown needed, only DB write"
metrics:
  duration: 5m
  completed: "2026-05-27"
  tasks_completed: 2
  files_changed: 4
---

# Phase 62 Plan 01: Backend IPC Extension Summary

**One-liner:** Extended update_task to accept labels/auto_approve/isolated_worktree via UpdateTaskRequest struct, added cancel_task IPC, regenerated bindings, and updated frontend service hooks.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Extend update_task and add cancel_task in Rust | 5d934a9 | task_handlers.rs, lib.rs |
| 2 | Regenerate bindings and update frontend service hook | da6b2df | bindings.ts, task.service.ts |

## What Was Built

### Rust Backend (`task_handlers.rs`)

- Added `UpdateTaskRequest` struct with 10 optional fields: `status`, `description`, `title`, `priority`, `base_branch`, `skills`, `agent_id`, `labels`, `auto_approve`, `isolated_worktree`
- Replaced flat-parameter `update_task` signature with `(app_state, task_id, updates: UpdateTaskRequest)` — 3 parameters total, well within specta limit
- Added `if let Some` blocks for `labels` (JSON-serialized, same pattern as `skills`), `auto_approve`, and `isolated_worktree` in the dynamic SET builder
- Added `cancel_task` function: executes `UPDATE tasks SET status = 'Cancelled', archived_at = ?, updated_at = ? WHERE id = ?`, reads back the task, emits `tasks-changed`
- Registered `crate::ipc::cancel_task` in `collect_commands![]` in `lib.rs`

### TypeScript Bindings (`bindings.ts`)

- `updateTask(taskId, updates: UpdateTaskRequest)` — struct-based signature
- `UpdateTaskRequest` type exported with all 10 optional fields
- `cancelTask(taskId: number): Promise<Result<Task, string>>` — new command

### Frontend Service (`task.service.ts`)

- `useUpdateTask` mutationFn now constructs `UpdateTaskRequest` from `Partial<Task>`, passing all 10 fields (including `labels`, `auto_approve`, `isolated_worktree`)
- `useCancelTaskMutation` exported after `useInterruptTaskMutation` — calls `api.cancelTask(taskId)`, invalidates `taskQueryKeys.lists()`, shows `toast.success("Task cancelled")`
- Added `UpdateTaskRequest` to the bindings import

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Refactored update_task to use UpdateTaskRequest struct**
- **Found during:** Task 1 (first cargo check attempt)
- **Issue:** specta 2.0.0-rc.22 only implements `SpectaFn` for functions up to 10 arguments. Adding 3 new parameters to `update_task` produced 12 positional args, exceeding the macro limit and failing to compile.
- **Fix:** Introduced `UpdateTaskRequest` struct (derives `serde::Deserialize` + `specta::Type`) to group all optional update fields. Reduced `update_task` from 12 to 3 parameters. This is consistent with the existing `CreateTaskRequest` pattern already in the codebase.
- **Files modified:** `src-tauri/src/ipc/task_handlers.rs`, `src/types/bindings.ts`, `src/services/task.service.ts`
- **Commits:** 5d934a9 (Rust), da6b2df (frontend)

**Impact on callers:** The generated `api.updateTask` call signature changed from positional args to `(taskId, UpdateTaskRequest)`. The `useUpdateTask` hook in `task.service.ts` was updated accordingly. No other callers of `api.updateTask` exist in the codebase.

## Verification

- `cargo check` passes (0 errors, 1 warning — pre-existing)
- `pnpm tauri:gen` regenerated bindings successfully (1 test passed)
- `pnpm build` passes (TypeScript + Vite, exit 0)
- `bindings.ts` contains `cancelTask(taskId: number)` and `UpdateTaskRequest` type with all new fields

## Known Stubs

None — plan 01 is purely backend/service infrastructure with no UI rendering.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundaries introduced. `cancel_task` follows the same pattern as `archive_task` (T-62-01: accepted per threat model).

## Self-Check: PASSED

- [x] `src-tauri/src/ipc/task_handlers.rs` modified — verified via git log
- [x] `src-tauri/src/lib.rs` modified — verified via git log
- [x] `src/types/bindings.ts` modified — verified via git log
- [x] `src/services/task.service.ts` modified — verified via git log
- [x] Commit 5d934a9 exists — Task 1
- [x] Commit da6b2df exists — Task 2
- [x] `cargo check` passed
- [x] `pnpm build` passed
