---
phase: 40-ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup
plan: "02"
subsystem: ssh
tags: [ssh, pty, heartbeat, cleanup, db]
dependency_graph:
  requires: [40-01]
  provides: [pty-cleanup-on-connection-loss]
  affects: [ssh/session.rs, ipc/ssh_handlers.rs]
tech_stack:
  added: []
  patterns: [arc-appstate-threading, process-ended-signaling, sqlite-json-object]
key_files:
  created: []
  modified:
    - src-tauri/src/ssh/session.rs
    - src-tauri/src/ipc/ssh_handlers.rs
decisions:
  - "Arc<AppState> threaded into spawn_heartbeat_task instead of separate ssh_sessions Arc — single Arc gives access to both ssh_pty_sessions and db without new parameters"
  - "Cleanup applied on initial connection loss only (not repeated on each reconnect attempt) — PTY sessions are already dead at first loss; no double-cleanup needed"
  - "Ordering::Release for process_ended.store() — pairs with Acquire loads in reader tasks for correct visibility"
  - "try_lock() for history snapshot — avoids async deadlock since reader task may hold the lock; if lock unavailable, history snapshot is skipped (history still in memory, partial loss acceptable vs. deadlock)"
metrics:
  duration: "0.046h"
  completed_date: "2026-04-10"
  tasks_completed: 1
  files_modified: 2
---

# Phase 40 Plan 02: PTY Session Cleanup on SSH Connection Loss Summary

PTY cleanup integrated into heartbeat task: marks running SSH PTY sessions as failed with `error_event=ssh_connection_lost`, persists terminal history to DB, and removes handles from the in-memory map when the SSH connection drops.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add PTY session cleanup to heartbeat task on connection loss | 3912925 | src-tauri/src/ssh/session.rs, src-tauri/src/ipc/ssh_handlers.rs |

## What Was Built

### `cleanup_pty_sessions_for_connection` (session.rs)

New `async fn` that runs in the heartbeat task's connection-loss path:

1. Iterates `app_state.ssh_pty_sessions` — collects all `log_id`s and snapshots terminal history via `try_lock()`
2. Signals reader tasks to stop via `handle.process_ended.store(true, Ordering::Release)` + `handle.notify.notify_one()`
3. Acquires `app_state.db` std Mutex (sync, never crosses `.await`) and:
   - `UPDATE execution_logs SET terminal_output = ?` for each history snapshot
   - `UPDATE execution_logs SET status = 'failed', completed_at = ?, error_event = json_object(...)` for all running sessions — uses `json_object('error_type', 'ssh_connection_lost', ...)` pattern
4. Removes handles from `ssh_pty_sessions` map

### `spawn_heartbeat_task` signature change (session.rs)

Changed from accepting `Arc<tokio::sync::Mutex<HashMap<i32, RemoteSshSession>>>` to `Arc<crate::db::AppState>`. Internal references updated: `ssh_sessions.lock()` → `app_state.ssh_sessions.lock()`.

Cleanup is called once, immediately after emitting `ssh-connection-lost`, before the reconnect loop begins.

### Call site updates (ssh_handlers.rs)

All 4 connect handlers (`connect_ssh_without_credentials`, `connect_ssh_with_password`, `connect_ssh_with_agent`, `connect_ssh_with_key`) updated to pass `Arc::clone(app_state.inner())` instead of `app_state.ssh_sessions.clone()`.

## Deviations from Plan

None — plan executed exactly as written. The `_connection_id` parameter is accepted but not used for filtering (all SSH PTY sessions are cleaned regardless of which connection lost) — this matches the plan's rationale: "a single user typically has only one SSH connection active" and `ssh_pty_sessions` only contains remote sessions.

## Known Stubs

None.

## Threat Flags

None. The `json_object` SQL pattern for `error_event` follows the existing schema convention established in Phase 40 planning. No new network endpoints or trust boundaries introduced.

## Self-Check: PASSED

- `src-tauri/src/ssh/session.rs` exists and contains `cleanup_pty_sessions_for_connection` at line 834
- `src-tauri/src/ipc/ssh_handlers.rs` contains `Arc::clone(app_state.inner())` at 4 call sites
- Commit `3912925` exists: `feat(40-02): add PTY session cleanup to heartbeat task on connection loss`
- `cargo test` passes: 11 tests, 0 failures
