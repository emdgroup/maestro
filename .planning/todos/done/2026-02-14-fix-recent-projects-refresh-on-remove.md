---
created: 2026-02-14T04:04
title: Fix recent projects refresh after removal in ProjectPickerNew
area: ui
files:
  - src/components/ProjectPickerNew.tsx
---

## Problem

The `handleRemoveRecentProject` function in ProjectPickerNew component currently requires a full window reload to refresh the recent projects list after removing a project. This results in a poor user experience with an unnecessary page refresh.

When a user removes a recent project from the list, the UI should immediately update to reflect the change without reloading the entire window/application.

## Solution

Implement local state refresh after the remove operation:

1. After calling the IPC command to remove the project (e.g., `invoke("remove_recent_project", { path })`), trigger a refresh of the recent projects list
2. Options:
   - Call the hook/function that loads recent projects again (e.g., refetch from `useRecentProjects` hook)
   - Update local state to filter out the removed project optimistically
   - Use React state management to trigger re-render with updated list

The goal is to update the UI immediately after removal without `window.location.reload()` or similar heavy operations.
