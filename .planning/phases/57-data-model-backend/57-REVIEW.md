---
phase: 57-data-model-backend
reviewed: 2026-05-26T00:00:00Z
depth: deep
files_reviewed: 7
files_reviewed_list:
  - src-tauri/src/db/schema.rs
  - src-tauri/src/models/task.rs
  - src-tauri/src/models/mod.rs
  - src-tauri/src/ipc/task_handlers.rs
  - src-tauri/src/lib.rs
  - src/services/task.service.ts
  - src/types/bindings.ts
findings:
  critical: 3
  warning: 4
  info: 3
  total: 10
status: issues_found
---

# Phase 57: Code Review Report

**Reviewed:** 2026-05-26
**Depth:** deep
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Phase 57 adds the `task_attachments` table (Schema V18), two new `Task` fields (`auto_approve`, `isolated_worktree`), a `TaskAttachment` model, four IPC handlers (attachment CRUD + `interrupt_task`), command registration in `lib.rs`, and TypeScript service hooks. The schema migration order and `from_row` column indices are correct. The critical mutex-across-await concern was addressed correctly — `interrupt_task` never holds the sync `db` mutex across an await point.

Three blockers are present: a type overflow hazard (`file_size: i32` truncates real file sizes), a silent error discard on the ACP cancel write inside `interrupt_task` that violates the project's own coding rule, and incorrect validation-vs-insert behavior in `create_task_impl` where the untrimmed string is stored. Four warnings cover robustness gaps: no test coverage for the new handlers, a missing `tasks-changed` event emission from `remove_task_attachment`, query invalidation scope gaps in the service, and session-ID format duplication. Three info items cover minor quality issues.

---

## Critical Issues

### CR-01: `file_size` stored as `i32` — truncates files larger than ~2 GB

**File:** `src-tauri/src/models/task.rs:82` and `src-tauri/src/ipc/task_handlers.rs:417`

**Issue:** `TaskAttachment.file_size` and the `add_task_attachment` parameter are typed as `i32`. A 32-bit signed integer maxes out at 2,147,483,647 bytes (~2 GB). Any file larger than that will silently overflow to a negative value when passed from the TypeScript frontend (which uses `number`, a 64-bit float) through the IPC boundary. SQLite stores it as an `INTEGER` with no constraint, so the value is persisted incorrectly without any error. This is a data-corruption defect for any workflow that attaches a large file.

**Fix:** Use `i64` in the Rust model and IPC parameter. Re-run `pnpm tauri:gen` to propagate.

```rust
// src-tauri/src/models/task.rs
pub struct TaskAttachment {
    pub id: i32,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,   // was i32
    pub created_at: String,
}

// src-tauri/src/ipc/task_handlers.rs  add_task_attachment signature
pub fn add_task_attachment(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    filename: String,
    file_path: String,
    file_size: i64,   // was i32
) -> Result<TaskAttachment, String> {
```

After regenerating bindings, `TaskAttachment.file_size` will remain `number` in TypeScript (unchanged), and the TypeScript service hook at `task.service.ts:482` also uses `fileSize: number`, so no TS changes are needed.

---

### CR-02: `interrupt_task` silently discards ACP cancel error — violates project rule

**File:** `src-tauri/src/ipc/task_handlers.rs:484`

**Issue:** The line `let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;` uses `let _ =` on a fallible async operation. The project's CLAUDE.md coding guidelines explicitly forbid this pattern:

> "Never silently discard errors with `let _ =` on fallible operations."

The sister function `cancel_acp_session` in `acp_handlers.rs:433` does the same thing intentionally (documented as "best-effort — server may already be gone"). The intent is fine, but the convention in this codebase for intentional error suppression is a comment explaining the reason (which is already present in `cancel_acp_session`). The `interrupt_task` copy has no explanatory comment at all, leaving it ambiguous whether the suppression is deliberate or an oversight.

This is a rules violation that will be caught by any reviewer enforcing the project standard, and it sets a bad precedent if copy-pasted.

**Fix:** Add the justification comment that `cancel_acp_session` uses, making the suppression explicit and traceable:

```rust
// Best-effort: server may already be gone or the session may have ended.
// Ignore the error — teardown continues regardless.
let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;
```

---

### CR-03: `create_task_impl` validates trimmed string but persists untrimmed — boundary bypass

**File:** `src-tauri/src/ipc/task_handlers.rs:36-52`

**Issue:** `trimmed_title` is computed and checked (must be 3–255 chars, non-empty), but the INSERT at line 52 uses `&title` — the original untrimmed value. A caller can pass a title like `"  a  "` (two spaces + one char + two spaces = 5 chars raw, 1 char trimmed), which passes the `trimmed_title.is_empty()` check but fails the `< 3` length check. However, a title like `"  abc  "` (7 raw, 3 trimmed) would pass the length check yet be stored with leading/trailing whitespace in the database, causing display inconsistencies and making the 3–255 character guarantee meaningless at the DB level.

More critically: a title of exactly `"  "` (two spaces) passes `trimmed_title.is_empty()` returning true, which correctly rejects it, but a title of `"   a   "` (3+1+3 = 7 chars raw, 1 char trimmed) passes the `len() < 3` guard (7 >= 3) and is stored with surrounding whitespace and an effective content length of 1, violating the stated intent.

**Fix:** Insert the trimmed values:

```rust
let now = Utc::now().to_rfc3339();
let skills_json = serde_json::to_string(&skills)
    .map_err(|e| format!("JSON serialization failed: {}", e))?;

conn.execute(
    "INSERT INTO tasks (project_id, title, description, skills, status, base_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    rusqlite::params![
        project_id,
        trimmed_title,       // use trimmed
        trimmed_description, // use trimmed
        &skills_json,
        "Backlog",
        &base_branch,
        &now,
        &now
    ],
)
```

---

## Warnings

### WR-01: `remove_task_attachment` does not emit `tasks-changed` event

**File:** `src-tauri/src/ipc/task_handlers.rs:434-442`

**Issue:** `remove_task_attachment` deletes an attachment record but does not emit a `tasks-changed` (or `attachments-changed`) Tauri event. The `useTaskAttachmentsQuery` hook in the service layer subscribes to `tasks-changed` for cache invalidation (inheriting from the top-level `useTasksQuery` listener). Without emitting an event, the UI cache is stale after a delete until the next manual refetch or window focus. The parallel `add_task_attachment` does not emit the event either. Both the query hook and the mutation hook (`useRemoveTaskAttachmentMutation`) call `queryClient.invalidateQueries` directly in `onSuccess`, which handles the optimistic case — but if another component is observing the same data via a separate query, it will not be notified.

The larger gap: the `remove_task_attachment` mutation invalidates only `taskQueryKeys.attachments(variables.taskId)` (service line 502), which is correct, but a raw DELETE with no event means any other listener (e.g., a future background sync) will not see the change.

**Fix:** Add an event emission, consistent with the pattern used by `delete_task`, `archive_task`, and `create_task`:

```rust
pub fn remove_task_attachment(
    app_state: State<Arc<AppState>>,
    attachment_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_attachments WHERE id = ?", [attachment_id])
        .map_err(|e| e.to_string())?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(())
}
```

The same fix should be applied to `add_task_attachment`.

---

### WR-02: No test coverage for new attachment handlers or `interrupt_task`

**File:** `src-tauri/src/ipc/task_handlers.rs:535-618`

**Issue:** The existing test module covers `create_task_impl` validation and `delete_task`. The three new attachment handlers (`get_task_attachments`, `add_task_attachment`, `remove_task_attachment`) have zero test coverage. These handlers are synchronous and straightforward to test in-process (using `test_db()`), so the absence is a gap rather than a feasibility problem. The `interrupt_task` function is async and depends on `AppState` locks which are harder to unit-test, but no test exists even for the "no active session" early-return path.

A regression in the `task_attachments` FK enforcement (e.g., deleting a task should cascade-delete its attachments) is not verified.

**Fix:** Add tests:

```rust
#[test]
fn add_and_get_task_attachment() {
    let conn = test_db();
    let project_id = insert_project(&conn);
    let task = create_task_impl(
        &conn, project_id,
        "Attach Test".to_string(),
        "Description long enough.".to_string(),
        vec![], "main".to_string(),
    ).unwrap();

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_attachments (task_id, filename, file_path, file_size, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task.id, "file.txt", "/tmp/file.txt", 1024i64, &now],
    ).unwrap();

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM task_attachments WHERE task_id = ?",
        [task.id], |r| r.get(0),
    ).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn delete_task_cascades_to_attachments() {
    let conn = test_db();
    let project_id = insert_project(&conn);
    let task = create_task_impl(/* ... */).unwrap();
    // insert attachment, delete task, verify attachment gone
}
```

---

### WR-03: `interrupt_task` uses inline `format!("session-{}", log_id)` instead of the shared `session_id_for` helper

**File:** `src-tauri/src/ipc/task_handlers.rs:482`

**Issue:** The session ID format string `"session-{}"` is duplicated inline in `interrupt_task`. The canonical helper `session_id_for(log_id)` is defined in `acp_handlers.rs` (line 77). If the session ID scheme ever changes, `interrupt_task` will silently diverge, sending a cancel message with a mismatched ID that the server will ignore (the server won't find the session). This is a maintenance correctness risk.

**Fix:** Move `session_id_for` to a shared location (e.g., `acp/mod.rs` or a new `acp/session.rs` helper) and call it from both sites:

```rust
// In interrupt_task — after moving session_id_for to acp mod:
use crate::acp::session_id_for;
let session_id = session_id_for(log_id);
```

---

### WR-04: `useUpdateTask` does not invalidate `taskQueryKeys.attachments` when task status changes

**File:** `src/services/task.service.ts:101-118`

**Issue:** `useUpdateTask` invalidates `taskQueryKeys.detail(data.id)` and `taskQueryKeys.lists()` on success (lines 112-114), but does not invalidate `taskQueryKeys.attachments(data.id)`. While `update_task` doesn't touch attachments, a component that displays a task with its attachments will not refetch attachments if it keys its query on the task's `updated_at` timestamp (which changes on every `update_task` call). This is a design coupling issue: if the frontend correlates task freshness with attachment freshness, the stale attachment list could show outdated data.

More importantly, the `useTaskAttachmentsQuery` hook at line 459 has no `staleTime`, meaning it defaults to `0` — so it will refetch on every component mount, but not in response to task mutations. If an agent attachment is added server-side and the UI only calls `update_task`, the attachment list will not update until the next mount.

**Fix:** Ensure attachment queries are invalidated when the owning task changes, or document that attachment and task lifecycles are intentionally decoupled:

```typescript
onSuccess: (data) => {
  void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(data.id) });
  void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: taskQueryKeys.attachments(data.id) });
},
```

---

## Info

### IN-01: Schema test does not verify `task_attachments` is absent before migration (regression gap)

**File:** `src-tauri/src/db/schema.rs:221-301`

**Issue:** The `test_schema_initialization` test verifies that `task_attachments` exists after initialization (line 253), and it verifies V15-V17 column presence, but it does not test the migration path: starting from an old schema version and migrating to V18. The DROP + recreate migration path is exercised indirectly, but no test starts with a V17 database and verifies that V18 is applied correctly (including the new `auto_approve` and `isolated_worktree` columns). Since the migration is destructive, this is low risk, but a version-mismatch test would catch future schema bump mistakes.

**Fix:** Add a test that sets `PRAGMA user_version = 17`, creates the old schema, then calls `initialize_schema` and verifies the new columns exist.

---

### IN-02: `unwrap_or` defaults in `from_row` mask DB inconsistencies

**File:** `src-tauri/src/models/task.rs:153-154`

**Issue:** Lines 153–154 use `unwrap_or(false)` and `unwrap_or(true)` as fallbacks for `auto_approve` and `isolated_worktree`:

```rust
auto_approve: row.get::<_, bool>(20).unwrap_or(false),
isolated_worktree: row.get::<_, bool>(21).unwrap_or(true),
```

A DB error reading these columns (e.g., type mismatch, column index out of range) is silently swallowed and replaced with the default value. The project guideline says "Avoid using functions that panic like `unwrap()`", and `unwrap_or` on a `rusqlite::Result` may look like a safe alternative, but here it hides errors. The `?` operator is used for all other columns. If the schema ever shifts and these columns move, the silent default will cause incorrect behavior that is hard to diagnose.

**Fix:** Propagate the error via `?`:

```rust
auto_approve: row.get::<_, bool>(20)?,
isolated_worktree: row.get::<_, bool>(21)?,
```

The schema defines both columns as `INTEGER NOT NULL DEFAULT 0/1`, so `?` will never fail in practice against a healthy DB, and any failure would be surfaced immediately.

---

### IN-03: `session_id` format in `interrupt_task` is not version-controlled via the helper

**File:** `src-tauri/src/ipc/task_handlers.rs:482`

**Issue:** This is the same root cause as WR-03 but from a discoverability angle: the `session_id_for` helper is private to `acp_handlers.rs` (`fn session_id_for`, no `pub`). Any future handler in a different module that needs to construct a session ID must either duplicate the format string or be moved into `acp_handlers.rs`. Exporting the helper to the `acp` module would prevent this class of divergence.

**Fix:** Make `session_id_for` `pub(crate)` in `acp_handlers.rs` or move it to `acp/mod.rs`, then use it in `interrupt_task`.

---

_Reviewed: 2026-05-26_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
