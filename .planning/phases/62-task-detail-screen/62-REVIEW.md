---
phase: 62-task-detail-screen
reviewed: 2026-05-27T14:25:33Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src-tauri/src/ipc/task_handlers.rs
  - src-tauri/src/lib.rs
  - src/services/task.service.ts
  - src/types/bindings.ts
  - src/components/task/TaskDetailScreen.tsx
findings:
  critical: 1
  warning: 4
  info: 2
  total: 7
status: issues_found
---

# Phase 62: Code Review Report

**Reviewed:** 2026-05-27T14:25:33Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Phase 62 adds a `TaskDetailScreen` component, a `cancel_task` IPC command, and supporting service hooks. The Rust backend is generally sound — the transaction pattern in `update_task` is correct, and `interrupt_task` correctly avoids holding the DB mutex across await points. The most important bugs are a data integrity issue in `create_task_impl` (untrimmed values stored), a stale-UI issue caused by `update_task_settings` not emitting `tasks-changed`, and a wrong navigation target type used when jumping to the agents view from the task detail screen.

---

## Critical Issues

### CR-01: `create_task_impl` validates trimmed values but inserts untrimmed originals

**File:** `src-tauri/src/ipc/task_handlers.rs:41-66`

**Issue:** `trimmed_title` and `trimmed_description` are computed and used for validation, but the INSERT statement at line 59 binds the original `&title` and `&description` variables — not the trimmed versions. A title like `"  ab  "` (padded to satisfy the 3-char check) is stored with leading/trailing whitespace. A description like `"  short   "` (9 printable chars but 10 with spaces) passes the `>= 10` byte check but circumvents the intent. The data stored in the DB differs from what was validated.

**Fix:**
```rust
let trimmed_title = title.trim().to_owned();
if trimmed_title.is_empty() || trimmed_title.len() < 3 || trimmed_title.len() > 255 {
    return Err("Title must be 3-255 characters".to_string());
}
let trimmed_description = description.trim().to_owned();
if trimmed_description.is_empty() || trimmed_description.len() < 10 {
    return Err("Description must be at least 10 characters".to_string());
}
// ... then use trimmed_title and trimmed_description in the INSERT
rusqlite::params![
    project_id, &trimmed_title, &trimmed_description, &skills_json, "Backlog", &base_branch,
    // ...
]
```

---

## Warnings

### WR-01: `update_task_settings` does not emit `tasks-changed`, causing stale task data in the UI

**File:** `src-tauri/src/ipc/task_handlers.rs:240-272`

**Issue:** `update_task_settings` modifies `model_override`, `mcp_allowlist`, and `skills_override` on the task row but never calls `app_state.app_handle.emit("tasks-changed", ())`. The `useTasksQuery` hook subscribes to the `tasks-changed` event to invalidate its cache. Until the user navigates away and back, the task data visible in the UI (and used by `TaskDetailScreen`) will be stale — the updated settings won't be reflected without a page-level refresh.

Compare with every other mutating handler in the same file (`update_task`, `cancel_task`, `archive_task`, `delete_task`, `interrupt_task`) which all emit the event.

**Fix:**
```rust
    conn.execute(
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![...],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();  // add this line
    Ok(())
```

### WR-02: `useUpdateTaskSettingsMutation` invalidates a phantom query key that no hook reads

**File:** `src/services/task.service.ts:127-131`

**Issue:** The `onSuccess` callback in `useUpdateTaskSettingsMutation` invalidates `taskQueryKeys.settingsByTask(variables.taskId)`. A search across the entire `src/` directory confirms no `useQuery` hook ever uses this key — it is defined in the key factory but never consumed. The invalidation is a no-op. Combined with WR-01, the actual task data (which comes from `useTasksQuery`) never refreshes after a settings update.

**Fix:** After the backend emits `tasks-changed` (WR-01), the `useTasksQuery` listener handles invalidation automatically. The `onSuccess` in the mutation can be simplified, or the `settingsByTask` key and associated factory entry should be removed to avoid confusion:
```typescript
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
},
```

### WR-03: "View agent session" button passes `task.id` (number) cast to string as `agentId`, which is matched against `session.task_id` (number) in `AgentsView` — works by coincidence but is semantically wrong

**File:** `src/components/task/TaskDetailScreen.tsx:382`

**Issue:** The navigation call is:
```typescript
onClick={() => navigate({ agentId: String(task.id) })}
```
`agentId` in `NavigationTarget` is typed as a string and is stored in `pendingAgentId`. In `AgentsView` (line 101), it is consumed as:
```typescript
const match = sessions.find((s) => String(s.task_id) === pendingAgentId);
```
So `pendingAgentId` is being used as a string-encoded `task_id`, not an `agentId`. The field is named `agentId` (implying an agent identifier like `"claude-code"`) and `pendingAgentId` is expected to hold an agent ID string throughout the rest of the codebase. This works today only because `AgentsView` specifically coerces `s.task_id` to string and compares. It is fragile: if `AgentsView` ever normalizes its matching logic based on the field's semantic meaning, this breaks silently.

**Fix:** Expose a proper navigation target variant or use the existing task-id based deep link correctly. If the intent is to navigate to the agents view and pre-select the session for a task, the `navigate` call should use a purpose-built target type:
```typescript
// Option A: add NavigationTarget variant
| { taskSessionId: number }

// Option B (interim, explicit, documents intent):
// In AgentsView, rename the field usage to make the encoding contract explicit
```

### WR-04: `handleResume` in `InterruptModal` silently ignores both the case where no session is found and errors from `sendAcpPrompt`

**File:** `src/components/task/TaskDetailScreen.tsx:123-129`

**Issue:** When the user clicks "Resume Work":
1. If `sessions.find((s) => s.task_id === taskId)` returns `undefined` (e.g., the session ended between modal open and button click), `api.sendAcpPrompt` is never called, but `onClose()` is still called — the UI dismisses the dialog without any feedback to the user that nothing happened.
2. `api.sendAcpPrompt` is called with `void`, discarding both the returned promise and any error it might throw.

In both cases the user gets no feedback that the resume failed.

**Fix:**
```typescript
async function handleResume() {
  const session = sessions.find((s) => s.task_id === taskId);
  if (!session) {
    toast.error("No active session found for this task.");
    onClose();
    return;
  }
  try {
    await api.sendAcpPrompt(session.session_key, "resume");
  } catch {
    toast.error("Failed to resume agent session.");
  }
  onClose();
}
```

---

## Info

### IN-01: `add_task_relationship` / `remove_task_relationship` do not validate `relationship_type` against known values

**File:** `src-tauri/src/ipc/task_handlers.rs:340-372`

**Issue:** `add_task_relationship` accepts any string for `relationship_type` with no validation. Any caller can insert arbitrary relationship type strings into the DB. If the frontend ever renders a type-specific UI (e.g., parent/child vs blocks/blocked-by) and the DB contains unknown values, the display logic will silently fall through. There is no `CHECK` constraint on the column and no server-side allow-list.

**Fix:** Add an explicit allow-list check before the INSERT, e.g.:
```rust
const VALID_RELATIONSHIP_TYPES: &[&str] = &["parent", "child", "blocks", "blocked_by", "related"];
if !VALID_RELATIONSHIP_TYPES.contains(&relationship_type.as_str()) {
    return Err(format!("Invalid relationship_type: {}", relationship_type));
}
```

### IN-02: `useAddTaskRelationshipMutation` only invalidates the `fromTaskId` relationships cache, not `toTaskId`

**File:** `src/services/task.service.ts:285-289`

**Issue:** When a relationship `A → B` is added, only the cache for `fromTaskId` (A) is invalidated. `useTaskRelationshipsQuery` for task B queries `"from_task_id = ? OR to_task_id = ?"`, so B should also show the new relationship — but its cache is not invalidated. If task B's detail screen is open in another tab, it will show stale data.

**Fix:**
```typescript
onSuccess: (_data, variables) => {
  void queryClient.invalidateQueries({
    queryKey: taskQueryKeys.relationships(variables.fromTaskId),
  });
  void queryClient.invalidateQueries({
    queryKey: taskQueryKeys.relationships(variables.toTaskId),
  });
},
```

---

_Reviewed: 2026-05-27T14:25:33Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
