---
phase: 59-board-view
plan: 02
subsystem: ui
tags: [react, kanban, filter, popover, typescript, shadcn, base-ui]

# Dependency graph
requires:
  - phase: 59-01
    provides: BoardView accepting tasks prop; KanbanView as data owner

provides:
  - KanbanView with real-time filter state (search query, priority, label) and AND-composed filteredTasks
  - Action bar with search Input, Priority Popover, Label Popover
  - BacklogView.tsx deleted (superseded by Backlog column)

affects: [60-filter-bar, 61-create-task-modal, 62-task-detail]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Filter state owned by KanbanView container; BoardView receives only the filtered subset"
    - "PopoverTrigger styled via buttonVariants() — base-ui popover lacks asChild"

key-files:
  created: []
  modified:
    - src/views/KanbanView.tsx
  deleted:
    - src/components/views/BacklogView.tsx
    - src/components/views/__tests__/BacklogView.test.tsx

key-decisions:
  - "Used buttonVariants() on PopoverTrigger instead of asChild — @base-ui/react/popover Trigger has no asChild prop (unlike Radix UI)"
  - "availableLabels derived from all tasks (unfiltered) so label popover always shows all known labels"

patterns-established:
  - "Filter state in container (KanbanView); presenter (BoardView) receives filtered prop — no filter logic in BoardView"

requirements-completed: [BOARD-01, BOARD-02, BOARD-03, BOARD-04]

# Metrics
duration: 10min
completed: 2026-05-26
---

# Phase 59 Plan 02: Board View Filter Bar Summary

**Real-time AND-composed task filtering added to KanbanView action bar (search + Priority popover + Label popover); BacklogView.tsx deleted**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-26T20:20:00Z
- **Completed:** 2026-05-26T20:30:00Z
- **Tasks:** 2
- **Files modified:** 1 (KanbanView.tsx); 2 deleted (BacklogView.tsx, BacklogView.test.tsx)

## Accomplishments
- KanbanView now owns filter state: `query`, `selectedPriorities`, `selectedLabels`
- `filteredTasks` computed via AND composition of all three filters before passing to BoardView
- Action bar populated with Search Input, Priority Popover (checkboxes + Clear), Label Popover (checkboxes + Clear)
- BacklogView.tsx and its test file deleted — no remaining references in codebase
- Pre-existing build errors (ImportTicketsModal.test.tsx, TaskForm.tsx) confirmed out-of-scope and unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Add filter state + action bar to KanbanView** - `33e8e08` (feat)
2. **Task 2: Delete BacklogView.tsx and its test** - `33ebba8` (feat)

## Files Created/Modified
- `src/views/KanbanView.tsx` - Filter state, availableLabels derivation, filteredTasks AND logic, populated action bar, passes filteredTasks to BoardView
- `src/components/views/BacklogView.tsx` - DELETED
- `src/components/views/__tests__/BacklogView.test.tsx` - DELETED

## Decisions Made
- `buttonVariants()` used directly on `PopoverTrigger` instead of `asChild` + `Button` — the project's popover component uses `@base-ui/react/popover` (not Radix UI) and `PopoverTrigger` does not expose an `asChild` prop. Applying `buttonVariants({ variant: "outline", size: "sm" })` to `PopoverTrigger.className` produces identical visual output.
- `availableLabels` derived from the full `taskList` (not `filteredTasks`) to ensure the label popover always shows all known labels regardless of active filters.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced `asChild` pattern on PopoverTrigger**
- **Found during:** Task 1 (action bar implementation)
- **Issue:** Plan specified `<PopoverTrigger asChild><Button ...>` but the project uses `@base-ui/react/popover` whose `Trigger` type has no `asChild` prop — caused TypeScript error TS2322
- **Fix:** Applied `buttonVariants({ variant: "outline", size: "sm" })` as `className` on `PopoverTrigger` directly; removed the `Button` wrapper
- **Files modified:** src/views/KanbanView.tsx
- **Verification:** TypeScript error resolved; visual appearance is identical
- **Committed in:** 33e8e08 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - component API mismatch)
**Impact on plan:** Minimal — visually identical to planned implementation; no scope change.

## Issues Encountered
- Pre-existing TypeScript build errors in `ImportTicketsModal.test.tsx` and `TaskForm.tsx` (missing `auto_approve`/`isolated_worktree` fixture fields from Phase 57 schema bump) remain. These were present before this plan and are logged in `.planning/phases/59-board-view/deferred-items.md`. Build is not cleaner after this plan, but also not worse.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all filter logic is fully wired to task data.

## Next Phase Readiness
- KanbanView now has full filter UX; BoardView receives only filtered tasks
- The container/presenter pattern is complete: KanbanView owns data + filter state, BoardView is a pure renderer
- Plan 60 (filter-bar) and Plan 61 (create-task-modal) can proceed independently

## Self-Check: PASSED

- FOUND: src/views/KanbanView.tsx
- FOUND: BacklogView.tsx deleted (correct)
- FOUND: BacklogView.test.tsx deleted (correct)
- FOUND: .planning/phases/59-board-view/59-02-SUMMARY.md
- FOUND: commit 33e8e08 (Task 1)
- FOUND: commit 33ebba8 (Task 2)

---
*Phase: 59-board-view*
*Completed: 2026-05-26*
