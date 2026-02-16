---
created: 2026-02-16T09:17
title: Fix recent projects dropdown not showing all projects for connection
area: ui
files:
  - src/components/AppHeader.tsx:62-66
  - src/App.tsx:44-47
  - src/hooks/useRecentProjects.ts:20
---

## Problem

The "recent project" dropdown in the app header does not display all recent projects for the current connection. When a user is working on a project from connection X (e.g., local or a specific SSH host), the dropdown should show all recent projects from that same connection, but some are missing.

**Current flow:**
1. `useRecentProjects()` fetches recent projects via `get_recent_projects_enhanced` IPC command
2. `App.tsx` filters all projects to only include recent ones (line 44-47: `recentProjectsOnly`)
3. `AppHeader` receives `recentProjectsOnly` and filters by connection (line 62-66)

**Potential causes:**
- Backend `get_recent_projects_enhanced` not returning complete list
- Filtering logic in `recentProjectsOnly` incorrectly excluding some projects
- Connection filtering in AppHeader using wrong comparison logic
- The `projects` state in App.tsx not containing all projects

## Solution

Investigate and fix:

1. Verify `get_recent_projects_enhanced` backend command returns all recent projects
2. Check if `recentProjectsOnly` filtering logic is correct (should match by path)
3. Verify AppHeader's `getConnectionId` function correctly identifies connection:
   - Local projects: returns "local"
   - Remote projects: returns "username@host"
4. Ensure filtering comparison is case-sensitive and handles edge cases
5. Add logging to debug what projects are being filtered at each stage
6. Consider if the issue is that `projects` state doesn't contain all projects from the connection

Test with multiple recent projects across different connections to verify fix.
