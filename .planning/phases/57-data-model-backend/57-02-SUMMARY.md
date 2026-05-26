---
phase: 57-data-model-backend
plan: "02"
subsystem: rust-backend
tags: [ipc-handlers, tanstack-query, typescript-bindings, attachment-crud, interrupt-task]
dependency_graph:
  requires: [57-01]
  provides: [ipc-get-task-attachments, ipc-add-task-attachment, ipc-remove-task-attachment, ipc-interrupt-task, ts-hooks-attachments, ts-hooks-interrupt]
  affects:
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/services/task.service.ts
tech_stack:
  added: []
  patterns: [scoped-async-lock, sync-mutex-after-await, tanstack-query-hooks]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/services/task.service.ts
decisions:
  - "file_size changed from i64 to i32 in TaskAttachment: specta BigIntForbidden constraint prevents i64 from being exported to TypeScript number; i32 is sufficient for desktop attachment files (up to ~2GB)"
  - "interrupt_task uses scoped lock blocks to search by task_id before any teardown, then releases locks immediately — sync DB mutex acquired only after all async locks are released, never held across await"
  - "interrupt_task returns Err for missing sessions (no silent success) — matches threat model T-57-04 mitigation"
metrics:
  duration: "~7 minutes"
  completed_date: "2026-05-26"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 5
---

# Phase 57 Plan 02: IPC Handlers + Service Hooks Summary

Four IPC commands added (attachment CRUD + interrupt_task), registered in lib.rs, TypeScript bindings regenerated with TaskAttachment type and invoke signatures, and four TanStack Query hooks exported from task.service.ts.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Attachment CRUD handlers + interrupt_task handler | 07b0553 | src-tauri/src/ipc/task_handlers.rs |
| 2 | Register commands in lib.rs + regenerate bindings | c1427c9 | src-tauri/src/lib.rs, src-tauri/src/models/task.rs, src/types/bindings.ts |
| 3 | Add service hooks to task.service.ts | 3f48af4 | src/services/task.service.ts |

## What Was Built

**Task 1 — IPC handlers in task_handlers.rs:**
- `get_task_attachments` (sync fn): queries `task_attachments WHERE task_id = ?`, returns `Vec<TaskAttachment>`
- `add_task_attachment` (sync fn): inserts attachment, uses `last_insert_rowid()` for id, returns constructed `TaskAttachment`
- `remove_task_attachment` (sync fn): `DELETE FROM task_attachments WHERE id = ?`
- `interrupt_task` (async fn with explicit lifetime): searches `acp.sessions` by `task_id` in scoped lock, searches `pty.session_meta` by `task_id` in scoped lock, returns Err for no active session, replicates `cancel_acp_session` ACP teardown and `close_pty_session` PTY teardown, then updates task status to Backlog via sync DB mutex (only acquired after all async locks are released), emits `tasks-changed` and `sessions-changed`

**Task 2 — Registration + bindings:**
- `TaskAttachment` added to `pub use models` line in lib.rs
- Four commands registered in `collect_commands!` macro with `// Task attachments + interrupt (Phase 57)` comment
- `TaskAttachment.file_size` changed from `i64` to `i32` to satisfy specta's `BigIntForbidden` constraint
- `pnpm tauri:gen` regenerated bindings with `TaskAttachment` type, updated `Task` type (auto_approve, isolated_worktree), and invoke signatures for all four commands

**Task 3 — TanStack Query hooks in task.service.ts:**
- `TaskAttachment` added to type import from `@/types/bindings`
- `taskQueryKeys.attachments(taskId)` added to factory
- `useTaskAttachmentsQuery` — `useQuery<TaskAttachment[]>`, enabled when taskId is non-null
- `useAddTaskAttachmentMutation` — invalidates `attachments(variables.taskId)` on success
- `useRemoveTaskAttachmentMutation` — invalidates `attachments(variables.taskId)` on success
- `useInterruptTaskMutation` — invalidates `lists()` on success
- All four use `createErrorToastHandler` for error feedback

## Verification

- `cargo test` (full suite): 79 passed, 4 ignored, 0 failures
- `cargo check`: 0 errors, 1 pre-existing warning
- `pnpm tauri:gen`: completed without error
- `grep -c "interrupt_task|..." lib.rs`: 4 commands confirmed
- `grep "TaskAttachment" bindings.ts`: type and 3 invoke signatures present
- `grep "auto_approve" bindings.ts`: Task type field confirmed
- All 4 hooks in task.service.ts confirmed
- `pnpm test` (vitest): 153 passed, 0 failures
- `npx oxlint src/services/task.service.ts`: 0 errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TaskAttachment.file_size i64 → i32 for specta BigInt compatibility**
- **Found during:** Task 2, when `pnpm tauri:gen` failed with `BigIntForbidden(... file_size -> i64)`
- **Issue:** specta cannot export `i64` as TypeScript `number` — it requires BigInt, which is not assignable to `number`
- **Fix:** Changed `file_size: i64` to `file_size: i32` in both the model struct and IPC handler signature. i32 is sufficient for desktop attachment files (max ~2GB)
- **Files modified:** src-tauri/src/models/task.rs, src-tauri/src/ipc/task_handlers.rs (model change committed with Task 2 as it is also a models file change)
- **Commit:** c1427c9

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns introduced beyond what was in the plan's threat model. interrupt_task crosses session management state as documented in T-57-04 (mitigated via Err return for invalid task_id).

## Self-Check: PASSED

- [x] `src-tauri/src/ipc/task_handlers.rs` — modified, committed in 07b0553
- [x] `src-tauri/src/models/task.rs` — modified (i64→i32), committed in c1427c9
- [x] `src-tauri/src/lib.rs` — modified, committed in c1427c9
- [x] `src/types/bindings.ts` — regenerated, committed in c1427c9
- [x] `src/services/task.service.ts` — modified, committed in 3f48af4
- [x] Commit 07b0553 exists in git log
- [x] Commit c1427c9 exists in git log
- [x] Commit 3f48af4 exists in git log
- [x] All cargo tests pass (79 passed)
- [x] All vitest tests pass (153 passed)
- [x] TaskAttachment type in bindings.ts confirmed
- [x] 4 hooks confirmed in task.service.ts
