---
phase: 39-fix-ssh-terminal-session-switching
plan: 01
subsystem: ssh
tags: [rust, ssh, terminal, pty, xterm, history-buffer, ansi]

# Dependency graph
requires:
  - phase: 38
    provides: diff view with git commit features (no SSH terminal dependency)
provides:
  - append_to_history fn with \x1b[2J clear-screen trimming and 512 KB byte-cap
  - SshPtyHandle.history as Arc<Mutex<String>> (was Vec<String>)
  - attach_terminal SSH path: live sessions start at pos=end, dead sessions read DB
  - DB persistence of SSH history to execution_logs.terminal_output on session death
affects: [39-02, 39-03, ssh, terminal, agents-view]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "append_to_history: rfind last \x1b[2J, drop-and-replace semantics for clear-screen"
    - "512 KB history cap: trim from front to nearest \r\n boundary, UTF-8 char boundary safe"
    - "Live SSH attach: pos=end at attach time, SIGWINCH triggers repaint"
    - "Dead SSH attach: read terminal_output from DB by log_id, return immediately"
    - "DB lock never held across tokio::sync::Mutex (drop hist before DB write)"

key-files:
  created: []
  modified:
    - src-tauri/src/ssh/session.rs
    - src-tauri/src/ipc/execution_handlers.rs

key-decisions:
  - "SshPtyHandle.history changed from Arc<Mutex<Vec<String>>> to Arc<Mutex<String>> — single String is the canonical buffer, append_to_history maintains invariant"
  - "pos in live attach loop is a byte offset into the String, not a chunk index into Vec"
  - "Dead sessions identified by process_ended.load(Acquire) at attach time — DB snapshot read immediately and returned"
  - "History persisted to execution_logs.terminal_output by log_id (not task_id) — matches the execution log row created at PTY spawn time"
  - "History lock dropped before DB write — std::sync::Mutex (DB) cannot be held while async tokio::sync::Mutex lock is held"

patterns-established:
  - "append_to_history: fn append_to_history(history: &mut String, chunk: &str) — all SSH output goes through this function"
  - "Live/dead split in attach_terminal: is_dead checked once at attach start, two distinct code paths"

requirements-completed: [SSH-HISTORY-TRIM, SSH-ATTACH-LIVE, SSH-ATTACH-DEAD, SSH-DB-PERSIST-EXIT]

# Metrics
duration: 3min
completed: 2026-04-08
---

# Phase 39 Plan 01: SSH History Buffer Rewrite Summary

**SSH history buffer rewritten from Vec<String> to trimmed String with \x1b[2J clear-screen semantics, 512 KB byte-cap, live/dead attach split, and DB persistence on session death**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-08T15:58:48Z
- **Completed:** 2026-04-08T16:01:48Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `fn append_to_history` to session.rs: rfind picks the last `\x1b[2J` in a chunk, clears history and keeps only the content from that point forward; 512 KB byte-cap trims from the front to the nearest `\r\n` boundary with UTF-8 char boundary safety
- Changed `SshPtyHandle.history` from `Arc<tokio::sync::Mutex<Vec<String>>>` to `Arc<tokio::sync::Mutex<String>>` and updated all 3 reader task call sites to use `append_to_history`
- Added 6 unit tests covering: clear-screen mid-chunk, clear-screen at end, normal append under cap, byte-cap trim with `\r\n` boundary, UTF-8 boundary safety (no panic), multiple clear-screens (rfind picks last)
- Rewrote `attach_terminal` SSH path: live sessions start at `pos=hist.len()` (no history replay), dead sessions read `terminal_output` from DB by `log_id` and return immediately, history persisted to DB when attach loop detects `process_ended`

## Task Commits

1. **Task 1: append_to_history + SshPtyHandle.history to String + unit tests** - `8bf3f40` (feat)
2. **Task 2: rewrite attach_terminal SSH path — live/dead split + DB persistence** - `9e0e0d7` (feat)

**Plan metadata:** (see final commit below)

## Files Created/Modified

- `src-tauri/src/ssh/session.rs` — added `fn append_to_history`, changed `SshPtyHandle.history` type, updated reader task (3 call sites), added `#[cfg(test)]` block with 6 tests
- `src-tauri/src/ipc/execution_handlers.rs` — rewrote SSH attach block: live/dead split, `pos=hist.len()` start, DB read for dead sessions, DB write on session death

## Decisions Made

- `SshPtyHandle.history` type changed from `Arc<Mutex<Vec<String>>>` to `Arc<Mutex<String>>` — a single String buffer is the correct abstraction for a terminal stream; `append_to_history` maintains all invariants
- `pos` in the live attach loop is a byte offset into the String, not a chunk index into Vec — this enables substring slicing (`&hist[pos..]`) instead of repeated clone-per-chunk
- Dead sessions identified at attach time by `process_ended.load(Acquire)` — no poll loop needed; read DB snapshot once and return
- `log_id` used for DB lookup (not `task_id`) — the execution log row is keyed by `log_id` at PTY spawn; using `task_id` would be ambiguous for task-free interactive sessions
- History lock dropped before DB write — `std::sync::Mutex` (SQLite) cannot be held concurrently with `tokio::sync::Mutex` (history) across an async context

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Implemented Task 2 before Task 1 tests could run**
- **Found during:** Task 1 verification
- **Issue:** Changing `SshPtyHandle.history` from `Vec<String>` to `String` caused 4 compile errors in `execution_handlers.rs` (old `chunks[pos]` Vec indexing no longer valid). `cargo test` could not compile the crate to run Task 1's unit tests.
- **Fix:** Implemented the Task 2 rewrite of `execution_handlers.rs` as part of resolving the blocking compile error. Both tasks were then committed separately in the correct order.
- **Files modified:** `src-tauri/src/ipc/execution_handlers.rs`
- **Verification:** `cargo test test_append_to_history` — 6/6 pass; `cargo test` — 11/11 pass; `cargo check` exits 0
- **Committed in:** `9e0e0d7` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (blocking compile dependency between tasks)
**Impact on plan:** No scope change — Task 2 was already planned. The only change was order of implementation.

## Issues Encountered

None — the blocking compile error between the two tasks was expected and resolved by implementing both in the same session before running tests.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SSH history buffer is now a trimmed String with semantic clear-screen handling — ready for Plan 02 (SIGWINCH repaint on attach) and Plan 03 (app-close persistence)
- `attach_terminal` SSH path fully rewritten: live and dead code paths are clean and independently testable
- All 11 Rust tests pass; no regressions

---
*Phase: 39-fix-ssh-terminal-session-switching*
*Completed: 2026-04-08*
