---
phase: 43-local-acp-session-manager
plan: "01"
subsystem: acp-session-manager
tags: [rust, acp, subprocess, tauri-events, appstate]
dependency_graph:
  requires: []
  provides: [acp-session-manager, acp-process-struct, appstate-acp-sessions]
  affects: [src-tauri/src/acp, src-tauri/src/db/connection.rs]
tech_stack:
  added: [which (PATH lookup), tokio::process::Command (subprocess spawn), oneshot cancel channel]
  patterns: [BufWriter flush-after-write, tokio::select! biased cancel, kill_on_drop(true)]
key_files:
  created:
    - src-tauri/src/acp/manager.rs
  modified:
    - src-tauri/src/acp/mod.rs
    - src-tauri/src/db/connection.rs
decisions:
  - "AcpProcess.reader_cancel_tx is Option<oneshot::Sender<()>> so it can be .take()-ed without Clone requirement"
  - "spawn_reader_task is a free fn (not method) — avoids borrow conflict between child_stdout (moved in) and acp_process stored in map"
  - "Session inserted into acp_sessions BEFORE reader task spawned — ensures IPC handlers see it immediately after spawn_acp_process returns"
  - "BufWriter::flush() called after every write_message — CRITICAL because BufWriter buffers; server would not receive message otherwise"
  - "tokio::select! { biased; } with cancel branch first — ensures explicit teardown takes priority over a stalled read"
metrics:
  duration: "0.112h"
  completed: "2026-04-20T23:09:44Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 43 Plan 01: AcpProcess Session Manager Summary

ACP session manager wiring: AcpProcess struct + spawn_acp_process function + background reader task emitting typed Tauri events, AppState extended with acp_sessions HashMap.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create AcpProcess struct and acp/manager.rs | 8a784d7 | src-tauri/src/acp/manager.rs, src-tauri/src/acp/mod.rs |
| 2 | Extend AppState with acp_sessions field | 073f004 | src-tauri/src/db/connection.rs |

## What Was Built

### AcpProcess (src-tauri/src/acp/manager.rs)

Runtime struct holding the live maestro-server subprocess state:
- `child: Child` — process handle with `kill_on_drop(true)` for automatic cleanup
- `stdin_writer: BufWriter<ChildStdin>` — write half for sending requests
- `reader_cancel_tx: Option<oneshot::Sender<()>>` — cancel channel for reader task teardown

### spawn_acp_process

Async function that:
1. Resolves `maestro-server` binary via `which::which()`
2. Spawns subprocess with `Stdio::piped()` stdin/stdout, `Stdio::inherit()` stderr
3. Sends initial `SpawnRequest` to server stdin
4. Inserts `AcpProcess` into `app_state.acp_sessions`
5. Spawns background `spawn_reader_task`

### spawn_reader_task (private)

Background task loop using `tokio::select! { biased; }`:
- Cancel branch (oneshot) takes priority for clean shutdown
- Read branch: calls `read_message` on stdout BufReader, routes `ServerResponse` variants:
  - `SessionUpdate` → `acp://session-update/{log_id}`
  - `TerminalOutput` → `acp://terminal-output/{log_id}`
  - `PermissionRequest` → `acp://permission-request/{log_id}`
  - `Error` → `acp://session-error/{log_id}`
  - `SpawnOk` → no event (success implied)
  - Request variants / unknown → ignored
  - `Err(_)` → break (EOF or parse error = server exited)
- After loop: removes session from `acp_sessions`, emits `acp://session-ended/{log_id}`

### write_to_acp_session (public)

Helper for IPC commands (Plan 02): locks `acp_sessions`, gets mutable borrow by `log_id`, calls `write_to_acp_session_raw`.

### AppState.acp_sessions (src-tauri/src/db/connection.rs)

New field: `pub acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpProcess>>`
Initialized to empty HashMap in `AppState::new()`. Follows the same pattern as `pty_sessions`.

## Verification

- `cargo check --workspace` — passes (0 errors)
- `cargo test -p maestro` — 11 tests pass, 0 failures
- `grep -c "app_handle.emit" src-tauri/src/acp/manager.rs` — returns 5 (≥4 required)
- All acceptance criteria for both tasks verified

## Deviations from Plan

None — plan executed exactly as written.

## Threat Model Verification

| Threat ID | Mitigation | Status |
|-----------|-----------|--------|
| T-43-01 | cwd passed via SpawnRequest JSON field, Command::new (no shell) | Implemented |
| T-43-02 | kill_on_drop(true) + session removal drops AcpProcess | Implemented |
| T-43-03 | read_message MAX_MESSAGE_SIZE guard in maestro-protocol | Pre-existing (Phase 41) |
| T-43-04 | agent_id serialized as JSON field, not shell argument | Implemented |
| T-43-05 | Events emitted to local Tauri webview only | Accept (no mitigation needed) |

## Self-Check: PASSED

- [x] src-tauri/src/acp/manager.rs exists
- [x] src-tauri/src/acp/mod.rs updated
- [x] src-tauri/src/db/connection.rs updated
- [x] Commit 8a784d7 exists (Task 1)
- [x] Commit 073f004 exists (Task 2)
