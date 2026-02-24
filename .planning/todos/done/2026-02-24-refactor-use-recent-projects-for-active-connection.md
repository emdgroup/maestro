---
created: 2026-02-24T13:41
title: Refactor useRecentProjects to use active connection
area: ui
files:
  - src/hooks/useRecentProjects.ts:1-26
  - src/hooks/useSshConnectionManager.ts
  - src-tauri/src/ipc/project_handlers.rs
---

## Problem

The `useRecentProjects` hook currently fetches all recent projects globally using `get_recent_projects_enhanced` IPC call, without considering the active SSH connection context. This means:

1. Projects are not filtered by the active connection
2. The list doesn't refresh when the user switches connections
3. There's no connection-aware project fetching

The hook needs to be refactored to integrate with the connection management system.

## Solution

Refactor the hook to:

1. Accept or consume the active connection ID/context (likely from `useSshConnectionManager`)
2. Replace `get_recent_projects_enhanced` with `get_connection_projects` IPC function
3. Add dependency on active connection to trigger refetch when connection changes
4. Update all usages of the hook to handle connection-aware project lists

This will ensure projects are properly scoped to the active connection and automatically refresh when users switch connections.
