---
created: 2026-02-15T21:08
title: Persist recent project removal
area: database
files:
  - src/components/RemoteProjectsList.tsx
  - src-tauri/src/ipc/handlers.rs
  - src-tauri/src/db/settings.rs
---

## Problem

When a user removes a project from the recent projects list in the UI, the change is not persisted to the database. After closing and restarting the application, the removed project reappears in the recent projects list.

This indicates that the removal operation is only updating the in-memory state but not calling the backend IPC command to update the `recent_projects` setting in the SQLite database.

## Solution

Investigate the recent project removal flow:

1. Check `RemoteProjectsList.tsx` (or `ProjectPicker.tsx`) for the remove handler
2. Verify if it calls the Tauri IPC command to update settings (likely `save_setting` or similar)
3. If the IPC call is missing, add it to persist the updated recent projects list
4. Ensure the backend handler in `handlers.rs` correctly updates the `settings` table
5. Test the fix by removing a project, restarting the app, and verifying it stays removed
