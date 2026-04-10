---
phase: 40-ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup
plan: "01"
subsystem: ssh
tags: [ssh, keepalive, heartbeat, tauri-events, reconnection, backend]
dependency_graph:
  requires: []
  provides: [ssh-keepalive-config, app-handle-in-appstate, spawn-heartbeat-task, ssh-connection-events]
  affects: [src-tauri/src/ssh/session.rs, src-tauri/src/db/connection.rs, src-tauri/src/main.rs, src-tauri/src/ipc/ssh_handlers.rs, src-tauri/src/ssh/mod.rs]
tech_stack:
  added: [tauri::Emitter trait, russh keepalive_interval/keepalive_max config]
  patterns: [background-tokio-task, tauri-event-emission, exponential-backoff-reconnect]
key_files:
  created: []
  modified:
    - src-tauri/src/ssh/session.rs
    - src-tauri/src/ssh/mod.rs
    - src-tauri/src/db/connection.rs
    - src-tauri/src/main.rs
    - src-tauri/src/ipc/ssh_handlers.rs
decisions:
  - "spawn_heartbeat_task lives in session.rs (same module) to access private fields: state, reconnect_attempts, session_password"
  - "Heartbeat uses execute_command('true') as probe — lightweight, no output, always exits 0 on live connection"
  - "is_transient_error gate: only ConnectionError retries; AuthenticationError/HostKeyError stops heartbeat immediately"
  - "Exponential backoff in heartbeat (1s-16s) is independent from reconnect_if_needed internal backoff (100ms-1600ms)"
  - "Early-return path in connect_ssh_without_credentials (existing session) skips heartbeat spawn — existing task still running"
metrics:
  duration_minutes: 4.65
  completed_date: "2026-04-10"
  tasks_completed: 2
  files_modified: 5
---

# Phase 40 Plan 01: SSH Keepalive, AppHandle in AppState, and Background Heartbeat Task Summary

russh keepalive configured at 30s interval (max 3 missed), AppHandle stored in AppState for event emission, and per-connection background heartbeat task that detects silent drops within 30s and reconnects with exponential backoff.

## Objective Achieved

SSH connections were silently dropping on cloud servers after 2-3 minutes idle because `open_handle()` had no keepalive. This plan adds proactive keepalive at the russh layer and a heartbeat detector that emits Tauri events so Plan 03 can show a reconnection backdrop UI.

## Tasks Completed

### Task 1: Add keepalive to open_handle + AppHandle to AppState
- `open_handle()` in `session.rs` now sets `keepalive_interval: Some(Duration::from_secs(30))` and `keepalive_max: 3` — russh sends `keepalive@openssh.com` every 30s and closes the connection internally after 3 missed replies (90s total)
- `AppState` struct gains `pub app_handle: AppHandle` field (with `use tauri::AppHandle` import)
- `AppState::new()` signature updated to `new(db: Connection, app_handle: AppHandle)`
- `main.rs` setup passes `app.handle().clone()` to `AppState::new()`

**Commit:** c70062d

### Task 2: Implement heartbeat task with Tauri event emission and reconnection
- `ReconnectingPayload` struct added (derives `Clone, Serialize`) for `ssh-reconnecting` event payload
- `spawn_heartbeat_task` public function added to `session.rs`: probes every 30s with `execute_command("true")`, emits 4 Tauri events, reconnects with exponential backoff (1s/2s/4s/8s/16s, max 5 attempts), stops on session removal or explicit disconnect
- `spawn_heartbeat_task` and `ReconnectingPayload` re-exported from `ssh/mod.rs`
- All 4 connect handlers (`connect_ssh_without_credentials`, `connect_ssh_with_password`, `connect_ssh_with_agent`, `connect_ssh_with_key`) spawn heartbeat after `finalize_ssh_connection` succeeds

**Commit:** e05b877

## Tauri Events Defined

| Event | Payload | When |
|-------|---------|------|
| `ssh-connection-lost` | `connection_id: i32` | Probe fails with transient error |
| `ssh-reconnecting` | `ReconnectingPayload { connection_id, attempt, max_attempts }` | Before each reconnect attempt |
| `ssh-reconnected` | `connection_id: i32` | Reconnect succeeds |
| `ssh-connection-failed` | `connection_id: i32` | All 5 attempts exhausted |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new security-relevant surface beyond what the plan's threat model covered. The hardcoded `"true"` probe command (T-40-01 mitigation) is in place — no user input reaches `execute_command` in the heartbeat path.

## Self-Check: PASSED

- `src-tauri/src/ssh/session.rs` — modified, contains `keepalive_interval`, `ReconnectingPayload`, `spawn_heartbeat_task`, all 4 emit calls
- `src-tauri/src/db/connection.rs` — modified, contains `pub app_handle: AppHandle`
- `src-tauri/src/main.rs` — modified, contains `AppState::new(conn, app.handle().clone())`
- `src-tauri/src/ipc/ssh_handlers.rs` — modified, contains 4 `spawn_heartbeat_task` call sites
- `src-tauri/src/ssh/mod.rs` — modified, re-exports `spawn_heartbeat_task`
- Commit c70062d: exists
- Commit e05b877: exists
- `cargo test`: 11 passed, 0 failed
