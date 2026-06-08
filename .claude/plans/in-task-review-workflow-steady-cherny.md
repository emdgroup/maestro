# Plan: Clear Review Comments After Agent Injection

## Context

When a user adds review comments and starts rework, comments get injected into the agent session (hot path: direct send to active session, cold path: fetched from DB on new session spawn). But the review persists in DB indefinitely, meaning:
- Old comments show up in subsequent review cycles confusing the user
- On cold restart, old comments get re-injected into the agent

The fix: delete the `task_reviews` row (CASCADE handles `review_comments`) after successful injection into the agent.

## Changes

### 1. New Rust IPC: `clear_task_review`

**File:** `src-tauri/src/git/review_handlers.rs` (after `get_task_review` ~line 160)

```rust
#[tauri::command]
#[specta::specta]
pub async fn clear_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM task_reviews WHERE task_id = ?",
        rusqlite::params![task_id],
    ).map_err(|e| format!("Delete review failed: {}", e))?;
    Ok(())
}
```

Idempotent — DELETE on zero rows is fine. CASCADE on `review_comments` handles child cleanup.

### 2. Register command

**File:** `src-tauri/src/lib.rs` — add `crate::ipc::clear_task_review` after line 64 (`get_task_review`).

### 3. Regenerate bindings

Run `pnpm tauri:gen` to produce `api.clearTaskReview(taskId)` in `src/types/bindings.ts`.

### 4. Clear in hot path (TaskReviewPanel)

**File:** `src/components/execution/diff/TaskReviewPanel.tsx` — in `handleReworkConfirm` `onSuccess` (line 279):

After sending prompt to active session (or calling `execute`), add:
```typescript
api.clearTaskReview(task.id).catch(() => {});
reviewStore.clearTask(task.id);
```

`reviewStore` already imported and available (line 82).

### 5. Clear in cold path (useExecuteTask)

**File:** `src/utils/hooks/useExecuteTask.ts` — after `sendAcpPromptStructured` (line 229):

```typescript
api.clearTaskReview(task.id).catch(() => {});
```

Only after successful prompt delivery. If send fails, review stays for retry.

## Verification

1. `cargo check` in `src-tauri/` — confirms Rust compiles
2. `pnpm tauri:gen` — generates new binding
3. `pnpm build` — confirms frontend compiles
4. Manual test: add review comments → rework → check DB has no review row → next review shows clean state
