---
created: 2026-02-15T02:26
title: Fix add task feature missing projectId parameter
area: ui
files:
  - src/components/TaskModal.tsx
  - src/components/TaskForm.tsx
  - src/store/boardStore.ts
  - src-tauri/src/ipc/handlers.rs
---

## Problem

The "Add Task" feature is currently broken with the following error when attempting to create a new task:

```
Task creation error: invalid args `projectId` for command `create_task`: command create_task missing required key projectId
```

This error indicates that the frontend is invoking the `create_task` IPC command without passing the required `projectId` parameter, or passing it with an incorrect key name.

The IPC command expects a `projectId` argument, but the frontend code is either:
1. Not passing the parameter at all
2. Passing it with a different key name (e.g., `project_id` instead of `projectId`)
3. Not properly extracting the current project ID from the application state

This is a critical bug as it prevents users from creating new tasks, which is a core feature of the application.

## Solution

Investigate and fix the parameter passing:

1. **Locate the IPC call**: Find where `create_task` is invoked in the frontend code (likely in TaskModal, TaskForm, or boardStore)
2. **Check parameter naming**: Verify the backend handler's expected parameter name in `src-tauri/src/ipc/handlers.rs`
3. **Fix the parameter**: Ensure the frontend passes `projectId` with the correct key name and value
4. **Source the project ID**: Ensure the current project ID is properly available and passed from the application state (likely stored in App.tsx or a global store)
5. **Test**: Verify task creation works end-to-end after the fix

The fix likely involves updating the invoke call to include the projectId parameter, for example:
```typescript
await invoke("create_task", {
  projectId: currentProjectId,
  // ... other parameters
});
```
