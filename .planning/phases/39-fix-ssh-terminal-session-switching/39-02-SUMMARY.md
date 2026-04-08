---
phase: 39-fix-ssh-terminal-session-switching
plan: 02
subsystem: ssh
tags: [rust, ssh, terminal, pty, atomic-bool, cancel-token, shutdown-hook]

# Dependency graph
requires:
  - phase: 39-01
    provides: SshPtyHandle.history as Arc<Mutex<String>>, attach_terminal SSH live/dead split, DB persistence on session death
provides:
  - pty_attach_cancel field on AppState (HashMap<i32, Arc<AtomicBool>>)
  - Cancel token creation in attach_terminal local PTY path
  - spawn_blocking reader checks cancel flag per iteration
  - detach_terminal cancels old reader (no longer a no-op)
  - Tauri RunEvent::Exit shutdown hook with two-phase SSH history DB flush
affects: [39-03, ssh, terminal, agents-view]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AtomicBool cancel token: Arc<AtomicBool> in pty_attach_cancel HashMap, checked at top of spawn_blocking loop with Ordering::Relaxed"
    - "Two-phase DB write pattern: collect snapshots from tokio Mutexes first, drop all async guards, then write via std::sync::Mutex (no .await after DB lock)"
    - "build() + app.run() Tauri pattern: enables RunEvent::Exit hook for graceful shutdown"

key-files:
  created: []
  modified:
    - src-tauri/src/db/connection.rs
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/main.rs

key-decisions:
  - "AtomicBool chosen over tokio::sync::watch for cancel token — watch::Receiver::changed().await is async and cannot be polled inside spawn_blocking; AtomicBool with Ordering::Relaxed is directly checkable from blocking threads"
  - "Two-phase lock pattern in shutdown hook: collect all tokio Mutex data first, drop guards, then acquire std::sync::Mutex for DB writes — prevents holding std::sync::MutexGuard<Connection> across any .await point"
  - "Sessions with process_ended=true skipped in shutdown hook — their history was already persisted by attach_terminal (from Plan 39-01)"

patterns-established:
  - "pty_attach_cancel: cancel old reader before creating new one in attach_terminal — prevents two reader tasks racing the same PTY fd"
  - "detach_terminal: remove flag from map and store true — map absence means no active reader"

requirements-completed: [LOCAL-PTY-CANCEL-TOKEN, SSH-DB-PERSIST-SHUTDOWN]

# Metrics
duration: 3min
completed: 2026-04-08
---

# Phase 39 Plan 02: Cancel Token + Shutdown Hook Summary

**AtomicBool cancel token eliminates local PTY reader race on session switch, and RunEvent::Exit shutdown hook flushes all live SSH PTY histories to SQLite via two-phase lock pattern**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-08T16:08:25Z
- **Completed:** 2026-04-08T16:11:36Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added `pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<AtomicBool>>>` to `AppState` in `connection.rs`
- `attach_terminal` local PTY path: cancels old reader by setting its `AtomicBool` to `true` before creating a new one; inserts new cancel flag into the map per `task_id`
- `spawn_blocking` reader task: checks `cancel_flag_reader.load(Ordering::Relaxed)` at the top of each iteration — exits cleanly when detach_terminal or re-attach cancels it
- `detach_terminal` rewritten from a no-op into a real cancellation: removes flag from `pty_attach_cancel` map and stores `true`
- `main.rs` restructured from `Builder::run()` to `Builder::build()` + `app.run()` pattern, enabling `RunEvent::Exit` hook
- Shutdown hook flushes live SSH PTY session histories to `execution_logs.terminal_output` using two-phase lock pattern (tokio Mutex first, then std::sync::Mutex — no `std::sync::MutexGuard` ever crosses an `.await` point)
- All 11 Rust tests pass; no regressions

## Task Commits

1. **Task 1: Add pty_attach_cancel to AppState + cancel token in attach/detach for local PTY** - `21ebd4f` (feat)
2. **Task 2: Add Tauri shutdown hook to flush all live SSH PTY session histories to DB** - `53a04bc` (feat)

**Plan metadata:** (see final commit below)

## Files Created/Modified

- `src-tauri/src/db/connection.rs` — added `use std::sync::atomic::AtomicBool`, new `pty_attach_cancel` field and initialization in `AppState::new`
- `src-tauri/src/ipc/execution_handlers.rs` — cancel token creation in `attach_terminal` local path, cancel flag check in `spawn_blocking` reader, `detach_terminal` rewritten from no-op to real cancellation
- `src-tauri/src/main.rs` — switched to `build()` + `app.run()` pattern; added `RunEvent::Exit` shutdown hook with two-phase SSH history flush

## Decisions Made

- `AtomicBool` chosen over `tokio::sync::watch` for cancel token: `watch::Receiver::changed().await` is async and cannot be polled inside `spawn_blocking`; `AtomicBool::load(Ordering::Relaxed)` works directly from blocking threads without any async bridge
- Two-phase lock pattern in shutdown hook: all tokio Mutex data collected into a `Vec<(i32, String)>` snapshot before any `std::sync::Mutex` acquisition; `drop(sessions)` called explicitly before `app_state.db.lock()` — `std::sync::MutexGuard<Connection>` never crosses an `.await`
- Sessions with `process_ended=true` are skipped in the shutdown hook because Plan 39-01 already persists history to DB when `attach_terminal` detects the process ended

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Local PTY stale-output flicker is eliminated: `detach_terminal` now cancels the old reader before a new `attach_terminal` creates a fresh one
- SSH PTY session history is never lost on app close: shutdown hook persists all live sessions to the database
- Both mechanisms are in place for Plan 39-03 (SIGWINCH repaint on attach) and any future local PTY attach work

## Self-Check: PASSED

- FOUND: .planning/phases/39-fix-ssh-terminal-session-switching/39-02-SUMMARY.md
- FOUND: commit 21ebd4f (Task 1)
- FOUND: commit 53a04bc (Task 2)

---
*Phase: 39-fix-ssh-terminal-session-switching*
*Completed: 2026-04-08*
