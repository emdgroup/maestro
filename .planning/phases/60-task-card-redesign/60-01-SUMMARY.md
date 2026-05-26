---
phase: 60
plan: "01"
subsystem: frontend-kanban
tags: [task-card, kanban, ui, refactor]
dependency_graph:
  requires: [58-navigation-store, 59-board-view]
  provides: [task-card-v2, worktree-badge, priority-dot, auto-approve-indicator]
  affects: [KanbanView, BoardView, KanbanColumn, TaskCard]
tech_stack:
  added: []
  patterns: [lucide-react icon, useNavigationActions, useWorktreesQuery, inline mutations]
key_files:
  created: []
  modified:
    - src/components/kanban/TaskCard.tsx
    - src/components/kanban/KanbanColumn.tsx
    - src/components/views/BoardView.tsx
    - src/views/KanbanView.tsx
decisions:
  - Card click calls setActiveTaskId via useNavigationActions (no onTaskClick prop)
  - Archive mutation called directly in TaskCard — no onArchiveClick prop needed
  - worktreeTaskIds derived in KanbanView from useWorktreesQuery and threaded down as prop
  - Metadata row only rendered when hasMetadata (priority !== None OR labels OR auto_approve)
metrics:
  duration: ~18min
  completed: "2026-05-26"
---

# Phase 60 Plan 01: TaskCard Rewrite Summary

TaskCard rebuilt with 3-row layout (title / metadata / footer), removing context menu, status dots, and full-width buttons in favor of compact per-status inline actions wired directly to mutations.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Remove context menu, status machinery, Back button | a237785 |
| 2 | Wire card click to setActiveTaskId | 11dbdb4 |
| 3 | Add PRIORITY_COLORS map and priority dot | 65e0dce |
| 4 | Restructure layout: title / metadata / footer rows | 16a8376 |
| 5 | Add ShieldAlert auto-approve indicator | d5473cb |
| 6 | Add worktreeTaskIds prop, thread KanbanView→TaskCard | 581cf61 |
| 7 | Wire inline action buttons with mutations | 6788621 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated KanbanColumn and BoardView as part of Task 1**
- **Found during:** Task 1
- **Issue:** Removing `onSettingsClick` and `onArchiveClick` from `TaskCardProps` caused TypeScript errors in callers (KanbanColumn, BoardView) still passing those props
- **Fix:** Removed `onSettingsClick`/`onArchiveClick` from KanbanColumnProps and BoardViewProps simultaneously; removed `TaskSettingsModal` render block and `useArchiveTaskMutation` from BoardView (archive now lives in TaskCard directly)
- **Files modified:** `src/components/kanban/KanbanColumn.tsx`, `src/components/views/BoardView.tsx`
- **Commit:** a237785

**2. [Rule 3 - Blocking] PRIORITY_COLORS needed usage in Task 3 to satisfy TypeScript**
- **Found during:** Task 3
- **Issue:** Declaring `PRIORITY_COLORS` without referencing it caused `TS6133: declared but never read` build error
- **Fix:** Added priority dot element in the same task commit rather than waiting for Task 4's layout restructure; Task 4 then kept it in the correct position
- **Files modified:** `src/components/kanban/TaskCard.tsx`
- **Commit:** 65e0dce

## Known Stubs

None — all action buttons are wired to real mutations or callbacks.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes.

## Self-Check: PASSED

- `src/components/kanban/TaskCard.tsx` — exists, contains line-clamp-2, PRIORITY_COLORS, ShieldAlert, worktreeTaskIds, all 4 action buttons
- `src/components/kanban/KanbanColumn.tsx` — exists, contains worktreeTaskIds prop
- `src/components/views/BoardView.tsx` — exists, contains worktreeTaskIds prop
- `src/views/KanbanView.tsx` — exists, calls useWorktreesQuery and derives worktreeTaskIds
- All 7 commits verified in git log: a237785, 11dbdb4, 65e0dce, 16a8376, d5473cb, 581cf61, 6788621
- `pnpm build` exits 0
- `pnpm test` — 149 passed, 8 todo, 0 failures
