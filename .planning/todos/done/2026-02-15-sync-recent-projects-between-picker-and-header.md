---
created: 2026-02-15T08:46
title: Sync recent projects between picker and header dropdown
area: ui
files:
  - src/components/ProjectPicker.tsx
  - src/components/AppHeader.tsx
  - src/App.tsx:37-47
  - src/hooks/useRecentProjects.ts
---

## Problem

The recent projects list is not synchronized between two UI locations:

1. **Project Picker screen** - Shows recent projects with ability to remove them
2. **App Header dropdown** - Shows projects in the dropdown after a project is selected

**Current behavior:**
When a user removes a project from the recent projects list in the ProjectPicker screen, the project still appears in the AppHeader dropdown menu. This creates an inconsistent user experience where the same data appears differently in two places.

**Root cause:**
The two components likely maintain separate state or pull from different sources. The AppHeader receives its `projects` list via props from App.tsx (line 226), which loads all projects via `loadAllProjects()` (line 37-47). This list is not filtered by recent projects, and there's no mechanism to update it when recent projects change in the picker.

## Solution

Implement proper state synchronization:

1. **Centralize recent projects state:**
   - Use the `useRecentProjects` hook in App.tsx (if not already)
   - Ensure both ProjectPicker and AppHeader consume the same state source

2. **React to removal events:**
   - When a project is removed in ProjectPicker, trigger a refetch of the projects list
   - Consider using a callback prop `onRecentProjectsChange` passed to ProjectPicker
   - Or emit an event that App.tsx listens to

3. **Filter projects in AppHeader:**
   - Option A: Only show recent projects in the dropdown
   - Option B: Show all projects but visually separate recent vs. all
   - Current implementation shows filtered projects per connection (AppHeader.tsx:61-65), but doesn't filter by recency

4. **State update flow:**
   ```
   User removes in ProjectPicker
   → useRecentProjects.refetch()
   → App.tsx.loadAllProjects()
   → AppHeader receives updated projects prop
   → Dropdown reflects current state
   ```

Consider adding a context provider for recent projects if this state needs to be shared across many components.
