---
created: 2026-02-15T02:17
title: Standardize action bar button positioning and styling
area: ui
files:
  - src/components/KanbanBoard.tsx
  - src/components/AgentMonitor.tsx
  - src/components/WorktreeManager.tsx
  - src/App.tsx
---

## Problem

Currently, action bars across different screens in the application lack consistent positioning and styling for their primary action buttons. This creates an inconsistent user experience where users need to search for the main action in different locations depending on which screen they're viewing.

Specific issues:
1. Primary action buttons are not consistently positioned on the right side of action bars
2. Primary buttons don't consistently use the "accent" variant to make them visually prominent
3. This inconsistency makes the UI feel less polished and harder to learn

## Solution

Implement a consistent pattern across all screen action bars:

1. **Button positioning**: Main/primary action button should always be positioned on the right side of the action bar
2. **Visual hierarchy**: Primary buttons should always use the "accent" variant to distinguish them from secondary actions
3. **Apply consistently**: Audit all screens (Tasks/Kanban, Agents, Worktrees, Settings) and ensure the pattern is applied uniformly

This may require:
- Creating a reusable ActionBar component with built-in layout logic
- Or establishing a clear pattern documented in the codebase
- Updating all existing action bars to follow the standard

The accent variant will use the system accent color (already integrated via ThemeProvider in Phase 17.1-03), providing a native feel that respects user preferences.
