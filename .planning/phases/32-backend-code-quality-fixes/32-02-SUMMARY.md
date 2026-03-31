---
phase: 32-backend-code-quality-fixes
plan: "02"
subsystem: backend
tags: [rust, refactor, dead-code, deduplication, model]
dependency_graph:
  requires: []
  provides: [poll_remote_log-shared-function, todo-local-stub, V5-WorktreeSnapshot]
  affects: [process/mod.rs, process/remote.rs, websocket/streaming.rs, models/project_state.rs, ipc/execution_handlers.rs]
tech_stack:
  added: []
  patterns: [shared-polling-function, delegation-pattern, todo-stub]
key_files:
  created: []
  modified:
    - src-tauri/src/process/mod.rs
    - src-tauri/src/process/remote.rs
    - src-tauri/src/websocket/streaming.rs
    - src-tauri/src/models/project_state.rs
    - src-tauri/src/ipc/execution_handlers.rs
decisions:
  - Local arm in spawn_agent_execution replaced with todo!() to prevent silent fake success on local path
  - poll_remote_log extracted as shared pub async fn to eliminate ~80 lines of duplicated polling code
  - resume_agent_execution now delegates to spawn_agent_execution (2-line body vs 40-line duplicate)
  - WorktreeSnapshot updated to V5 schema (task_id + git_status, removing status/leased_at/returned_at)
metrics:
  duration: "0.033h"
  completed_date: "2026-03-31"
  tasks_completed: 2
  files_modified: 5
---

# Phase 32 Plan 02: Fix dead local stub, deduplicate remote log polling, fix stale model, eliminate near-duplicate execution functions

Replaced fake local ProcessOutput stub with `todo!()`, extracted shared `poll_remote_log` function eliminating ~80 lines of duplicated SSH polling, updated `WorktreeSnapshot` to V5 schema, and made `resume_agent_execution` delegate to `spawn_agent_execution`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix local spawner stub, extract shared polling, fix WorktreeSnapshot | bf54d79 | process/mod.rs, process/remote.rs, websocket/streaming.rs, models/project_state.rs |
| 2 | Make resume_agent_execution delegate to spawn_agent_execution | b1d879f | ipc/execution_handlers.rs |

## What Was Built

**H3 — Local arm stub (process/mod.rs):**
Replaced the fake `ProcessOutput { success: true, ... }` in the `GitConnection::Local` arm with `todo!("Local agent spawning via process/mod is not yet implemented — ...")`. The Remote arm is fully preserved and unchanged.

**H4 — Shared poll_remote_log (process/remote.rs + websocket/streaming.rs):**
Extracted `pub async fn poll_remote_log(ssh_session, remote_pid, output_sender)` from the duplicated polling loop that existed in both `stream_remote_output` and `attach_remote_stream_listener`. Both callers now delegate to the shared function. Eliminated ~80 lines of duplicated SSH log-polling code.

**M4 — WorktreeSnapshot V5 (models/project_state.rs):**
Replaced `status: String`, `leased_at: Option<String>`, `returned_at: Option<String>` with `task_id: Option<i32>` and `git_status: Option<String>` to match the V5 DB schema columns.

**M7 — resume_agent_execution delegation (ipc/execution_handlers.rs):**
Replaced the 40-line duplicated body with a 2-line delegation: `spawn_agent_execution(app_state, project_id, task_id, repo_path).await`. Parameter order is correctly swapped (resume takes task_id second, spawn takes project_id second).

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `cargo check` passes (Finished dev profile in both tasks)
- `todo!()` present in Local arm, Remote arm preserved with `spawn_remote_agent_execution` call
- `poll_remote_log` defined in remote.rs, called from both remote.rs and streaming.rs
- `WorktreeSnapshot` has `task_id` and `git_status`, no `status`/`leased_at`/`returned_at`
- `resume_agent_execution` body is 2 lines (delegation only)

## Self-Check: PASSED
