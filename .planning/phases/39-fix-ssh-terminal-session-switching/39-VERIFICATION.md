---
phase: 39-fix-ssh-terminal-session-switching
verified: 2026-04-08T16:14:49Z
status: passed
score: 11/11
overrides_applied: 0
re_verification: false
---

# Phase 39: Fix SSH Terminal Session Switching — Verification Report

**Phase Goal:** Fix two root causes of the "cached screen" bug when switching terminal sessions: (1) SSH sessions replay full history from pos=0 on every attach — fix by converting history to trimmed String, starting live sessions at pos=end, and reading dead sessions from DB; (2) local PTY sessions have a two-reader race from no-op detach_terminal — fix with AtomicBool cancel token. Also adds Tauri shutdown hook to flush SSH histories to DB on app close, and frontend rAF reorder to ensure blank-then-repaint mount timing.
**Verified:** 2026-04-08T16:14:49Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

All must-haves are drawn from PLAN frontmatter truths across plans 01, 02, and 03.

#### Plan 01 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `append_to_history` trims buffer on `\x1b[2J` clear-screen sequence | VERIFIED | `session.rs:32` — `chunk.rfind("\x1b[2J")` clears history and keeps content from that position forward |
| 2 | `append_to_history` caps buffer at 512 KB with `\r\n` boundary trim | VERIFIED | `session.rs:37–49` — `MAX_BYTES = 512 * 1024`, trims to `\r\n` boundary with UTF-8 char boundary safety |
| 3 | SSH `attach_terminal` for live sessions starts at `pos=end` (no history replay) | VERIFIED | `execution_handlers.rs:253–256` — `let mut pos: usize = { let hist = history.lock().await; hist.len() };` |
| 4 | SSH `attach_terminal` for dead sessions reads `terminal_output` from DB | VERIFIED | `execution_handlers.rs:229–247` — `is_dead` branch queries `SELECT terminal_output FROM execution_logs WHERE id = ?` by `log_id` |
| 5 | SSH session history is persisted to `execution_logs.terminal_output` when attach loop ends with `process_ended=true` | VERIFIED | `execution_handlers.rs:282–291` — `UPDATE execution_logs SET terminal_output = ? WHERE id = ?` with `log_id` after `hist.clone()` and `drop(hist)` |

#### Plan 02 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 6 | `detach_terminal` cancels the old reader task via AtomicBool before new attach starts | VERIFIED | `execution_handlers.rs:612–619` — non-no-op: removes flag from `pty_attach_cancel` map and stores `true`; also `execution_handlers.rs:333–338` cancels on re-attach without explicit detach |
| 7 | `attach_terminal` local PTY path creates and stores a cancel flag per `task_id` | VERIFIED | `execution_handlers.rs:341–345` — `Arc<AtomicBool::new(false)>` created and inserted into `pty_attach_cancel` map |
| 8 | Local PTY reader task checks cancel flag and exits cleanly when set | VERIFIED | `execution_handlers.rs:392–394` — `cancel_flag_reader.load(Ordering::Relaxed)` at top of `spawn_blocking` loop; exits on `true` |
| 9 | Tauri shutdown hook flushes all live SSH PTY session histories to `execution_logs.terminal_output` | VERIFIED | `main.rs:48–88` — `RunEvent::Exit` handler; two-phase lock pattern: collects snapshots from tokio Mutex, `drop(sessions)`, then writes via `std::sync::Mutex`; skips sessions with `process_ended=true` |

#### Plan 03 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 10 | `tryAttach()` is called inside the `requestAnimationFrame` callback, after `fitAddon.fit()` | VERIFIED | `Terminal.tsx:80–87` — rAF callback: `fitAddon.fit()` → `terminal.write(...)` → `tryAttach()` at line 86 |
| 11 | Terminal writes clear-screen escape `\x1b[2J\x1b[H` before `tryAttach()` | VERIFIED | `Terminal.tsx:85` — `terminal.write('\x1b[2J\x1b[H')` on the line immediately before `tryAttach()` |

**Score:** 11/11 truths verified

---

### Additional Acceptance Criteria Checks

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `SshPtyHandle.history` is `Arc<Mutex<String>>` (not `Vec<String>`) | VERIFIED | `session.rs:63` — `pub history: Arc<tokio::sync::Mutex<String>>` |
| `append_to_history` function exists in `session.rs` | VERIFIED | `session.rs:31` — `fn append_to_history(history: &mut String, chunk: &str)` |
| Reader task uses `append_to_history` at all 3 call sites | VERIFIED | `session.rs:712–720, 720–728, 733–738` — all 3 match arms (Data, ExtendedData, ExitStatus) call `append_to_history` |
| 6 unit tests present in `session.rs` | VERIFIED | `session.rs:772–832` — `#[cfg(test)] mod tests` with 6 test functions |
| All 6 `test_append_to_history_*` tests pass | VERIFIED | `cargo test test_append_to_history` — 6/6 pass, confirmed by live run |
| `AppState` has `pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<AtomicBool>>>` | VERIFIED | `connection.rs:58` |
| `AppState::new` initializes `pty_attach_cancel` | VERIFIED | `connection.rs:70` — `pty_attach_cancel: tokio::sync::Mutex::new(HashMap::new())` |
| `main.rs` uses `build()` + `app.run()` pattern | VERIFIED | `main.rs:41–88` |
| `main.rs` contains `tauri::RunEvent::Exit` | VERIFIED | `main.rs:49` |
| Old Vec pattern `chunks[pos]` / `while pos < chunks.len()` removed | VERIFIED | No matches in `execution_handlers.rs` |
| No standalone `tryAttach()` call outside rAF | VERIFIED | Grep finds exactly 2 occurrences: definition at line 62, call inside rAF at line 86 |
| `cargo check` passes | VERIFIED | `cargo check` exits 0 |

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/ssh/session.rs` | `append_to_history` fn + `String` history type on `SshPtyHandle` | VERIFIED | Contains `fn append_to_history`, `pub history: Arc<tokio::sync::Mutex<String>>`, 3 call sites in reader task, 6 unit tests |
| `src-tauri/src/ipc/execution_handlers.rs` | Rewritten SSH attach path with live/dead split + DB persistence; cancel token for local PTY | VERIFIED | `is_dead` branch present, `pos=hist.len()` start, DB read/write by `log_id`, `pty_attach_cancel` usage, `detach_terminal` is non-no-op |
| `src-tauri/src/db/connection.rs` | `pty_attach_cancel` field on `AppState` | VERIFIED | Field and initialization both present |
| `src-tauri/src/main.rs` | `RunEvent::Exit` shutdown hook with SSH history DB flush | VERIFIED | `build()` + `app.run()` pattern, two-phase lock, snapshot collection before DB write |
| `src/components/execution/Terminal.tsx` | Fixed mount timing: fit → clear-screen → attach inside single rAF callback | VERIFIED | `fitAddon.fit()` → `terminal.write('\x1b[2J\x1b[H')` → `tryAttach()` all inside rAF |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `session.rs` | `execution_handlers.rs` | `SshPtyHandle.history` as `Arc<Mutex<String>>` + `process_ended` flag | VERIFIED | `execution_handlers.rs:219–256` clones `handle.history`, locks it, takes byte-offset `pos=hist.len()` |
| `execution_handlers.rs` | `db/connection.rs` | `AppState.pty_attach_cancel` HashMap | VERIFIED | `execution_handlers.rs:334, 343` — `app_state.pty_attach_cancel.lock().await` used in both cancel-old and insert-new paths |
| `main.rs` | `db/connection.rs` | `AppState.ssh_pty_sessions` + `AppState.db` for shutdown flush | VERIFIED | `main.rs:57` — `app_state.ssh_pty_sessions.lock().await`; `main.rs:78` — `app_state.db.lock()` after `drop(sessions)` |
| `Terminal.tsx` | Backend PTY | `api.attachTerminal` IPC call inside rAF after fit | VERIFIED | `Terminal.tsx:86` — `tryAttach()` inside rAF callback which calls `api.attachTerminal(taskId, channel, null)` |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `execution_handlers.rs` SSH dead path | `db_output` | `SELECT terminal_output FROM execution_logs WHERE id = ?` | Yes — real DB query by `log_id` | FLOWING |
| `execution_handlers.rs` SSH live path | `hist[pos..]` | `Arc<Mutex<String>>` history buffer populated by reader task from SSH channel data | Yes — SSH channel output via `append_to_history` | FLOWING |
| `execution_handlers.rs` DB persistence | `history_snapshot` | `hist.clone()` from live session buffer on `process_ended` | Yes — accumulated SSH output | FLOWING |
| `main.rs` shutdown flush | `snapshots` | `handle.history.lock().await` on each live SSH session | Yes — in-memory SSH output | FLOWING |
| `Terminal.tsx` | `output` | `channel.onmessage` from `api.attachTerminal` IPC | Yes — backend sends real PTY output | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 6 `append_to_history` unit tests pass | `cd src-tauri && cargo test test_append_to_history` | 6 passed, 0 failed | PASS |
| Codebase compiles without errors | `cd src-tauri && cargo check` | Finished dev profile, 0 errors | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SSH-HISTORY-TRIM | 39-01 | History buffer trims on clear-screen, caps at 512 KB | SATISFIED | `append_to_history` in `session.rs` with rfind and byte-cap |
| SSH-ATTACH-LIVE | 39-01 | Live sessions start at pos=end (no history replay) | SATISFIED | `pos=hist.len()` at attach time in `execution_handlers.rs` |
| SSH-ATTACH-DEAD | 39-01 | Dead sessions read from DB snapshot | SATISFIED | `is_dead` branch queries `terminal_output` from DB by `log_id` |
| SSH-DB-PERSIST-EXIT | 39-01 | History persisted to DB when session ends via attach loop | SATISFIED | `UPDATE execution_logs SET terminal_output = ? WHERE id = ?` with `log_id` |
| LOCAL-PTY-CANCEL-TOKEN | 39-02 | AtomicBool cancel token for local PTY reader tasks | SATISFIED | `pty_attach_cancel` in `AppState`, checked in `spawn_blocking` loop |
| SSH-DB-PERSIST-SHUTDOWN | 39-02 | Tauri shutdown hook flushes live SSH histories to DB | SATISFIED | `RunEvent::Exit` handler with two-phase lock in `main.rs` |
| FRONTEND-RAF-REORDER | 39-03 | `tryAttach()` moved inside rAF after `fitAddon.fit()` | SATISFIED | `Terminal.tsx:80–87` — rAF callback contains fit → clear → attach |
| FRONTEND-CLEAR-SCREEN-GUARD | 39-03 | Clear-screen escape written before `tryAttach()` | SATISFIED | `terminal.write('\x1b[2J\x1b[H')` at line 85, before line 86 |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `execution_handlers.rs` | 636 | `// TODO: Send SIGSTOP to running process` | Info | `pause_agent_execution` pre-existing stub; unrelated to phase 39 scope — process pause was already a placeholder before this phase |

No blockers or warnings found in phase 39 scope.

---

### Human Verification Required

The following behaviors require live app testing and cannot be verified statically:

**1. No stale content flash on SSH terminal session switch**

**Test:** Open two SSH-based agent sessions in the Agents view. Switch between them by clicking tabs multiple times.
**Expected:** Each switch shows a blank terminal frame briefly, then the running program repaints its current screen via SIGWINCH. No old session output is visible when switching to a different session.
**Why human:** SIGWINCH repaint is a runtime behavior between the xterm frontend, Tauri IPC, and the remote SSH program. Cannot be verified by static code analysis.

**2. Dead session recovery shows correct DB snapshot**

**Test:** Open an SSH agent session, let it run to completion (process exits), then close and reopen the app. Navigate to the completed session in Agents view.
**Expected:** The terminal shows the session's output history as it was when the session ended.
**Why human:** Requires a real SSH connection, session lifecycle, app restart, and visual confirmation.

**3. Local PTY sessions do not flash stale content on tab switch**

**Test:** Open two local (non-SSH) agent sessions. Switch between them rapidly.
**Expected:** Each switch shows the correct session's current output without stale content from the previous session.
**Why human:** Cancel token effectiveness depends on timing between reader goroutine teardown and new attach — a runtime race condition that requires UI interaction to confirm.

---

### Gaps Summary

No gaps found. All 11 observable truths are verified. All 5 documented commits exist in the repository. All 8 phase requirements are satisfied. `cargo check` and all 6 unit tests pass. The only open items are runtime behaviors requiring human testing (visual confirmation of the session-switching UX fix), which is expected for a terminal rendering fix.

---

_Verified: 2026-04-08T16:14:49Z_
_Verifier: Claude (gsd-verifier)_
