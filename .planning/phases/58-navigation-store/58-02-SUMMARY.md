---
phase: 58-navigation-store
plan: "02"
subsystem: frontend-view
tags: [navigation, kanban, cleanup, refactor, typescript]
dependency_graph:
  requires: [navigationStore-activeTaskId-api, TaskDetailScreen-stub]
  provides: [KanbanView-activeTaskId-routing, App-without-pendingTask-flow]
  affects: [KanbanView, App.tsx, KanbanProvider consumers]
tech_stack:
  added: []
  patterns: [zustand-selector-hooks, conditional-render-by-store-state]
key_files:
  created: []
  modified:
    - src/views/KanbanView.tsx
    - src/App.tsx
decisions:
  - "onTaskClick on KanbanProvider set to no-op () => {} — KanbanContext still typed, Phase 61 replaces with CreateTaskModal flow"
  - "KanbanView action bar left empty (placeholder div) — Phase 59 populates it with board-specific controls"
  - "Suspense fallback={null} wrapper kept in App.tsx — still needed for TaskModal lazy load"
metrics:
  duration: "~8 min"
  completed: "2026-05-26"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 58 Plan 02: KanbanView Simplification and App.tsx Cleanup Summary

Rewired KanbanView to route between BoardView and TaskDetailScreen via `activeTaskId` from navigationStore, and stripped the pendingTask/TaskDetail flow from App.tsx.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Simplify KanbanView — remove sub-view routing, add activeTaskId guard | b75475e | src/views/KanbanView.tsx |
| 2 | Clean App.tsx — remove pendingTask/TaskDetail flow | 917972e | src/App.tsx |

## What Was Built

- `KanbanView.tsx`: Reduced from 143 lines to 21 lines. All sub-view machinery removed: `useState`, `LayoutList`, `Kanban`, `Archive`, `SearchIcon`, `BacklogView`, `ArchiveView`, `ToggleGroup`, `ToggleGroupItem`, `Tooltip*`, `Input`, `TaskPriority`, `useActiveSubView`, `useNavigationActions`, `SubView`, `InputGroup*`, `ArchiveFilter`, `BacklogPriorityFilter`, `SUB_VIEWS`, `BACKLOG_PRIORITY_FILTERS` are all gone. Component now calls `useActiveTaskId()` and renders `<TaskDetailScreen taskId={activeTaskId} />` when non-null, or the board layout (empty action bar + `<BoardView />`) when null.
- `App.tsx`: Removed `usePendingTaskId`, `Task` type import, `useTasksQuery`, lazy `TaskDetail` import, `selectedTask` state, `clearPendingTask`, the `pendingTaskId` resolution `useEffect`, and the `<TaskDetail>` JSX render. `<TaskModal>` and its `<Suspense fallback={null}>` wrapper preserved. `onTaskClick` on `KanbanProvider` replaced with `() => {}` no-op for Phase 61 cleanup.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

| File | Line | Description |
|------|------|-------------|
| src/views/KanbanView.tsx | 14 | Empty action bar div — Phase 59 populates with board-specific controls |
| src/components/task/TaskDetailScreen.tsx | 6 | Stub body renders only taskId text (from Plan 01) — Phase 62 replaces with full UI |

Both stubs are intentional per plan. They do not prevent Plan 02's goal (wiring the navigation store into the view layer).

## Threat Flags

None — changes are client-side UI routing only. No new network endpoints, auth paths, or file access patterns introduced.

## Self-Check: PASSED

- src/views/KanbanView.tsx: FOUND
- src/App.tsx: FOUND
- Commit b75475e: FOUND
- Commit 917972e: FOUND
- 15 navigationStore tests: PASSING
- TypeScript: No errors
- oxlint: Clean (both files)
