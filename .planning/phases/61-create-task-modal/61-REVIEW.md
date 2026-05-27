---
phase: 61-create-task-modal
reviewed: 2026-05-27T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - src-tauri/src/db/schema.rs
  - src-tauri/src/ipc/task_handlers.rs
  - src-tauri/src/models/task.rs
  - src/App.tsx
  - src/components/kanban/CreateTaskModal.tsx
  - src/components/kanban/__tests__/CreateTaskModal.test.tsx
  - src/contexts/KanbanContext.tsx
  - src/services/task.service.ts
  - src/types/bindings.ts
  - src/views/KanbanView.tsx
findings:
  critical: 2
  warning: 4
  info: 2
  total: 8
status: issues_found
---

# Phase 61: Code Review Report

**Reviewed:** 2026-05-27
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

This phase delivers the Create Task Modal: a React dialog with branch selection, priority, agent assignment, issue tracking integration (From Issue tab), and a "create another" convenience toggle. The Rust backend adds `create_task`, `list_project_branches`, and `get/add/remove_task_attachment` commands, plus a schema migration to V19 that adds the `task_attachments` table.

The overall structure is solid. The critical issues are: (1) the Rust handler validates trimmed inputs but inserts the _untrimmed_ originals, producing tasks with leading/trailing whitespace stored permanently; and (2) `update_task` will construct a valid SQL statement even when called with all-None fields (no-op call), silently succeeding with a spurious `updated_at` bump and event emission. Both are correctness bugs that cannot be caught at the database layer.

Four warnings cover: silent invalid-priority storage, a broken branch-refresh query key, a null-projectId guard bypassed by `?? 0`, and `React.FC` usage without a React import.

---

## Critical Issues

### CR-01: Trimmed input validated but raw (untrimmed) input inserted into database

**File:** `src-tauri/src/ipc/task_handlers.rs:40-58`

**Issue:** `create_task_impl` computes `trimmed_title` and `trimmed_description` for validation (lines 40-46), correctly rejecting whitespace-only strings and enforcing minimum length. However, the `INSERT` on lines 57-64 binds the _original_ (untrimmed) `&title` and `&description` parameters, not the trimmed versions. A title like `"  hi there  "` passes the length check (12 chars) and is stored with surrounding spaces. This means every task created via the API can have whitespace-padded titles stored in the database, which then surface in the UI, search, and any downstream consumers.

**Fix:**
```rust
// Replace lines 58-59 in the rusqlite::params![] block:
project_id, trimmed_title, trimmed_description, &skills_json, "Backlog", &base_branch,
```
Also change the local bindings to owned strings so the borrow is valid:
```rust
let trimmed_title = title.trim().to_string();
let trimmed_description = description.trim().to_string();
```

---

### CR-02: `update_task` accepts all-None arguments and silently succeeds

**File:** `src-tauri/src/ipc/task_handlers.rs:119-173`

**Issue:** `update_task` builds its SET clause by appending only non-None optional fields. The `updated_at` column is unconditionally appended (line 154), so the SQL is always syntactically valid. If a caller passes all-None arguments the produced SQL is `UPDATE tasks SET updated_at = ? WHERE id = ?` — this executes without error, bumps `updated_at`, emits `tasks-changed`, and returns the task, giving the caller a false impression that an update was applied. There is no guard that returns an error when `set_parts` contains only `updated_at`.

This is a logical correctness bug: the contract of `update_task` is to change at least one user-visible field, not to touch `updated_at` alone.

**Fix:**
```rust
// After the if-let blocks and before the unconditional updated_at push, add:
if set_parts.is_empty() {
    return Err("update_task called with no fields to update".to_string());
}
// Then unconditionally push updated_at as before.
set_parts.push("updated_at = ?".to_string());
params.push(Box::new(now));
```

---

## Warnings

### WR-01: Priority string stored without validation — arbitrary values accepted

**File:** `src-tauri/src/ipc/task_handlers.rs:60`

**Issue:** `create_task_impl` passes `priority.as_deref().unwrap_or("Medium")` directly into the database INSERT with no enum validation. A caller can store arbitrary strings (e.g., `"CRITICAL"`, `"foo"`) in the `priority` column. The `FromStr` impl for `TaskPriority` silently maps unknown values back to `Medium`, so the stored garbage is masked on read-back but the DB now contains an unrecognised value. The same problem exists in `update_task` (line 134-137).

**Fix:**
```rust
// In create_task_impl, after trimming, validate priority:
let priority_str = priority.as_deref().unwrap_or("Medium");
let _ = priority_str.parse::<crate::models::TaskPriority>()
    .map_err(|_| format!("Invalid priority: {}", priority_str))?;
// Then pass priority_str to the INSERT.
```
The `FromStr` impl currently silently falls back; change the unknown arm to return `Err(...)` to make it useful for validation.

---

### WR-02: Branch refresh button uses a hardcoded inline query key that diverges from the canonical key in `useProjectBranchesQuery`

**File:** `src/components/kanban/CreateTaskModal.tsx:249-251`

**Issue:** The refresh button calls:
```ts
void queryClient.invalidateQueries({
  queryKey: [...taskQueryKeys.base, "branches", projectId],
})
```
This exactly replicates the internal key defined in `useProjectBranchesQuery` in `task.service.ts` line 346:
```ts
queryKey: [...taskQueryKeys.base, "branches", projectId],
```
While currently correct, this is fragile: the key is not exported and is duplicated as an inline array literal. If `useProjectBranchesQuery` changes its key structure the invalidation silently stops working. This is already a divergence risk.

**Fix:** Export a key factory from `task.service.ts` and use it in both places:
```ts
// In task.service.ts
export const taskQueryKeys = {
  ...
  branches: (projectId: number) => [...taskQueryKeys.base, "branches", projectId] as const,
};
// In useProjectBranchesQuery:
queryKey: taskQueryKeys.branches(projectId!),
// In CreateTaskModal:
queryKey: taskQueryKeys.branches(projectId),
```

---

### WR-03: `projectId ?? 0` passed to `CreateTaskModal` bypasses query guards

**File:** `src/views/KanbanView.tsx:146`

**Issue:**
```tsx
<CreateTaskModal
  isOpen={isCreateModalOpen}
  onClose={() => setIsCreateModalOpen(false)}
  projectId={projectId ?? 0}
/>
```
`projectId` is `selectedProject?.id ?? null`. When `selectedProject` is `null` (not expected in normal flow since `App.tsx` guards it, but theoretically reachable), this passes `0` to `CreateTaskModal`. Inside the modal, `useProjectBranchesQuery(isOpen ? projectId : null)` receives `0` when the modal is open — the `enabled` guard checks `projectId !== null`, so `0` is truthy and the query fires with `project_id = 0`, issuing an IPC call that will return an error or empty list depending on what the Rust handler does with a non-existent project ID. The better fix is to keep `projectId` as `number | null` and disable the modal entirely when null.

**Fix:**
```tsx
{projectId !== null && (
  <CreateTaskModal
    isOpen={isCreateModalOpen}
    onClose={() => setIsCreateModalOpen(false)}
    projectId={projectId}
  />
)}
```
And change `CreateTaskModalProps.projectId` to `number` (unchanged) with the call site gated on non-null.

---

### WR-04: `React.FC` used in `KanbanView` without a React import

**File:** `src/views/KanbanView.tsx:17`

**Issue:**
```tsx
export const KanbanView: React.FC = () => {
```
The file contains no `import React from "react"` or `import type { FC } from "react"`. In React 17+ JSX transform the runtime is injected automatically, but `React.FC` as a type reference still requires `React` to be in scope at the type level. In strict TypeScript this compiles only because `React` is available as a global namespace from another import in the module graph; however, it is a missing explicit import and will fail if the global ambient declaration is removed or in isolated module configurations.

**Fix:**
```tsx
import type { FC } from "react";
// ...
export const KanbanView: FC = () => {
```
Or add `import React from "react"` at the top.

---

## Info

### IN-01: All test cases in `CreateTaskModal.test.tsx` are `it.todo` — no assertions execute

**File:** `src/components/kanban/__tests__/CreateTaskModal.test.tsx:47-69`

**Issue:** The test file sets up comprehensive mocks but all eight test cases are `it.todo(...)`, meaning the test suite passes trivially (todos are skipped, not failed) without exercising any component behaviour. The mocks have been written and are correct, but no assertions follow. This is not a quality blocker on its own, but the described test plan (CREATE-01 through CREATE-04) is entirely unexecuted. Regression risk is non-zero for the "create another" toggle and the issue pre-fill paths.

**Fix:** Implement the test bodies. The mock scaffolding already exists; render `<CreateTaskModal>` using Testing Library and assert on form fields, tab visibility, and mutation calls.

---

### IN-02: `CreateTaskRequest` model is defined but never used as an IPC parameter type

**File:** `src-tauri/src/models/task.rs:163-169`

**Issue:**
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub title: String,
    pub description: String,
    pub skills: Vec<String>,
}
```
The `create_task` IPC command takes individual parameters, not a `CreateTaskRequest` struct. This struct is exported to the TypeScript bindings (`src/types/bindings.ts` contains no `CreateTaskRequest` — confirming specta did not pick it up via any command signature) and exists purely as dead code. It also lacks the `base_branch`, `priority`, `agent_id`, `auto_approve`, and `isolated_worktree` fields that the actual command requires, making it stale/misleading.

**Fix:** Remove `CreateTaskRequest` or update it to match the current command signature and actually use it as the IPC parameter type.

---

_Reviewed: 2026-05-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
