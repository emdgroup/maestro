---
phase: quick-260410-awn
plan: 01
subsystem: execution
tags: [execution, pty, kanban, task-context, named-session]
key-files:
  modified:
    - src-tauri/src/ipc/execution_handlers.rs
    - src/components/kanban/TaskCard.tsx
    - src/types/bindings.ts
    - src/services/execution.service.ts
decisions:
  - "AND status = 'Ready' guard on task status UPDATE prevents overwriting state if task already InProgress on re-execute"
  - "clone write_tx before inserting pty_handle into ssh_pty_sessions map to avoid move-after-use in remote description injection"
  - "drop(sessions) moved after description injection tokio::spawn for local PTY path so Arc::clone of session is still valid"
  - "AgentsView callers pass no taskId/taskDescription — new params are optional with ?? null defaults so no call-site changes needed"
metrics:
  duration_minutes: 3
  completed_date: "2026-04-10T08:00:51Z"
  tasks_completed: 2
  files_modified: 4
---

# Quick Task 260410-awn: Enhance Task Execution with Named Session Injection

One-liner: claude agent launched with named session (`-n <task_name>`) and task description injected via PTY stdin 2s post-spawn, with automatic InProgress status transition on both local and remote execution paths.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Add task_id/description params, named session args, description injection, and status update to spawn_interactive_execution | ada3024 | src-tauri/src/ipc/execution_handlers.rs |
| 2 | Update frontend TaskCard and bindings to pass task_id and description | 23e2473 | src/types/bindings.ts, src/components/kanban/TaskCard.tsx, src/services/execution.service.ts |

## What Was Built

### Backend (`spawn_interactive_execution`)

- Added `task_id: Option<i32>` and `task_description: Option<String>` parameters
- Execution log INSERT now stores the actual `task_id` (previously always `NULL`)
- Task status updated to `InProgress` in DB when `task_id` is provided and current status is `Ready` (guarded by `AND status = 'Ready'`)
- Claude launched with `-n <session_name>` for both local PTY and remote SSH paths
- Task description injected into PTY stdin via `tokio::spawn` + 2-second sleep for both local and remote paths
- Remote: clones `write_tx` before inserting handle into session map (avoids move-after-use)
- Local: Arc-clones session reference before dropping sessions lock, then injects description

### Frontend

- `pnpm tauri:gen` auto-regenerated bindings with new `taskId` and `taskDescription` params
- `TaskCard.handleExecute` passes `task.id` and `task.description` to `spawnInteractiveExecution`
- Optimistic UI update: `store.updateTaskStatus(task.id, "InProgress")` called after successful spawn
- `useSpawnInteractiveExecutionMutation` extended with optional `taskId` / `taskDescription` fields
- `onSuccess` now invalidates both `executionQueryKeys.all` and `["tasks"]` so kanban refreshes from DB
- AgentsView callers unchanged — new params are optional, default to `null` via `?? null`

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or trust boundaries introduced. Session name single-quoted in SSH command as planned (T-quick-01 mitigation).

## Self-Check: PASSED

- `src-tauri/src/ipc/execution_handlers.rs` — modified, cargo check passed
- `src/types/bindings.ts` — regenerated with new params
- `src/components/kanban/TaskCard.tsx` — modified, build passed
- `src/services/execution.service.ts` — modified, build passed
- Commit ada3024 — exists
- Commit 23e2473 — exists
