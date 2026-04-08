---
status: resolved
trigger: "task-promote-demote-hang — Clicking Promote button causes app to freeze indefinitely"
created: 2026-04-08T00:00:00Z
updated: 2026-04-08T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — std::sync::Mutex deadlock in update_task handler: mutex is locked twice on same thread
test: Code audit of src-tauri/src/ipc/task_handlers.rs update_task function
expecting: N/A — root cause confirmed through static analysis
next_action: Report findings

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Task status changes (e.g. Backlog → Ready), Kanban board updates
actual: App freezes indefinitely after clicking Promote — UI becomes unresponsive, no crash dialog
errors: No visible error message — silent hang
reproduction: Click the "Promote" button visible on task cards in the Backlog view
started: Unsure if this ever worked

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Network/IPC timeout or async issue in frontend
  evidence: IPC call reaches Rust handler; issue is a blocking deadlock in synchronous Rust code, not an async/timeout problem
  timestamp: 2026-04-08

- hypothesis: Database query returns no results / SQL error
  evidence: The deadlock occurs before the SELECT read-back query even executes; lock is never released so query never starts
  timestamp: 2026-04-08

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-08
  checked: src/components/views/BacklogView.tsx handlePromote (line 69-71)
  found: calls updateMutation.mutate({ taskId: task.id, updates: { status: "Ready" } })
  implication: Triggers useUpdateTask mutation

- timestamp: 2026-04-08
  checked: src/services/task.service.ts useUpdateTask (lines 97-118)
  found: mutationFn calls api.updateTask(taskId, status, ...) which invokes TAURI_INVOKE("update_task", ...)
  implication: IPC call goes to Rust update_task command handler

- timestamp: 2026-04-08
  checked: src/utils/helpers/tauri-utils.ts (api proxy wrapper)
  found: api is a proxy over generated commands; wraps Result<T,E> — standard pattern, no hang here
  implication: No frontend-side issue; IPC layer is fine

- timestamp: 2026-04-08
  checked: src-tauri/src/ipc/task_handlers.rs update_task (lines 73-143)
  found: Line 84 acquires std::sync::Mutex lock into `mut conn` (MutexGuard<Connection>). Line 88 calls conn.transaction() which takes &mut self (mutable borrow, NOT move). Lines 133/136 execute and commit the transaction. tx is dropped after commit(), releasing the mutable borrow on conn — but `conn` (the MutexGuard) is still alive and still holds the mutex. Line 139 then calls app_state.db.lock() again on the SAME thread, attempting to acquire a mutex that the current thread already holds.
  implication: std::sync::Mutex is NOT reentrant. The second lock() call blocks forever. The IPC handler never returns. The UI hangs indefinitely.

- timestamp: 2026-04-08
  checked: src-tauri/src/db/connection.rs AppState definition (line 49)
  found: pub db: Mutex<Connection> — std::sync::Mutex (not tokio::sync::Mutex). Non-reentrant by design.
  implication: Confirms double-lock on same thread = guaranteed deadlock

- timestamp: 2026-04-08
  checked: Comment at task_handlers.rs line 138: "Re-lock to read back (conn was moved into tx, acquire a fresh lock)"
  found: The comment's premise is false. rusqlite Connection::transaction() borrows &mut self — it does NOT consume/move conn. conn is still a live MutexGuard after tx.commit().
  implication: The developer believed conn was moved into tx and therefore the lock was released. This was the mental model error that introduced the bug.

## Resolution

root_cause: >
  Double mutex acquisition on the same thread in update_task (src-tauri/src/ipc/task_handlers.rs).
  Line 84 acquires app_state.db.lock() into `mut conn`. Line 88 calls conn.transaction() which
  borrows conn mutably (does NOT move it). After tx.commit() on line 136, the Transaction is dropped
  and the mutable borrow is released — but conn (the MutexGuard) is still alive, still holding the
  std::sync::Mutex lock. Line 139 then attempts app_state.db.lock() a second time on the same thread.
  std::sync::Mutex is not reentrant, so this blocks forever, causing a permanent deadlock / UI hang.
  The erroneous code comment ("conn was moved into tx") reveals the developer believed the lock was
  already released — it was not.

fix: >
  Drop the MutexGuard before the second lock() call. The simplest fix is to wrap the transaction
  block in its own scope so conn is dropped when that scope exits, then re-acquire for the SELECT
  read-back. Alternatively, perform the read-back SELECT inside the same transaction before committing
  (eliminating the need for a second lock entirely).

verification:
files_changed:
  - src-tauri/src/ipc/task_handlers.rs
