---
phase: 23-add-in-app-routing-for-deep-linking-to-specific-screens
plan: 02
subsystem: ui
tags: [react, zustand, navigation, routing, deep-linking]

# Dependency graph
requires:
  - phase: 23-01
    provides: navigationStore with navigate(), selector hooks, and all pending ID state
provides:
  - App.tsx wired to navigationStore (useActiveTab, useSlideDirection, usePendingTaskId)
  - KanbanView activeSubView backed by navigationStore
  - AppHeader importing ViewType from navigationStore
  - AgentsView consuming pendingAgentId from store
  - WorktreesView consuming pendingWorktreeId from store
  - usePageRouting.ts deleted, hooks index cleaned
affects: [any component that navigates between views or deep-links to entities]

# Tech tracking
tech-stack:
  added: []
  patterns: [store-backed navigation state, pending entity ID consumption pattern]

key-files:
  created: []
  modified:
    - src/App.tsx
    - src/components/common/AppHeader.tsx
    - src/views/KanbanView.tsx
    - src/views/AgentsView.tsx
    - src/views/WorktreesView.tsx
    - src/utils/hooks/index.ts
  deleted:
    - src/utils/hooks/usePageRouting.ts

key-decisions:
  - "App.tsx reads all nav state from navigationStore; usePageRouting deleted entirely"
  - "pendingTaskId effect in App.tsx resolves task by string ID match against boardStore tasks array"
  - "AgentsView uses effectiveAgentId (pendingAgentId overrides prop) to forward to AgentMonitor"
  - "WorktreesView triggers onWorktreeClick callback when highlightedWorktreeId is set by navigate()"

patterns-established:
  - "Pending entity ID pattern: read from store, compute effective value, consume in useEffect with clear call"
  - "View components own their pending ID consumption; App.tsx owns pendingTaskId (cross-cutting concern)"

requirements-completed:
  - NAV-WIRE

# Metrics
duration: 4min
completed: 2026-03-28
---

# Phase 23 Plan 02: Consumer Rewire Summary

**All consumer components wired to navigationStore: usePageRouting deleted, KanbanView/AgentsView/WorktreesView read from store, pendingTaskId/AgentId/WorktreeId all consumed**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-28T14:27:46Z
- **Completed:** 2026-03-28T14:30:56Z
- **Tasks:** 3
- **Files modified:** 6 (1 deleted)

## Accomplishments
- App.tsx replaced `usePageRouting` with navigationStore hooks (`useActiveTab`, `useSlideDirection`, `useNavigationActions`), added `pendingTaskId` effect that opens TaskDetail sheet
- KanbanView lifted `activeSubView` from local useState to navigationStore (`useActiveSubView`/`setActiveSubView`)
- AgentsView and WorktreesView both consume pending entity IDs from store and clear them after consumption
- Deleted `usePageRouting.ts` hook; all functionality now lives in navigationStore

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewire App.tsx and AppHeader to use navigationStore** - `48bc09b` (feat)
2. **Task 2: Rewire KanbanView, delete usePageRouting, update hooks index** - `9d30c38` (feat)
3. **Task 3: Wire AgentsView and WorktreesView to consume pending entity IDs** - `d4b8e6b` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/App.tsx` - Removed usePageRouting import; added navigationStore hooks; pendingTaskId useEffect opens TaskDetail
- `src/components/common/AppHeader.tsx` - Removed local ViewType definition; imports from navigationStore
- `src/views/KanbanView.tsx` - Replaced useState activeSubView with useActiveSubView/setActiveSubView from store
- `src/views/AgentsView.tsx` - Added pendingAgentId consumption with clearPendingAgent; forwards effectiveAgentId to AgentMonitor
- `src/views/WorktreesView.tsx` - Added pendingWorktreeId consumption with clearPendingWorktree; triggers onWorktreeClick on highlight
- `src/utils/hooks/index.ts` - Removed usePageRouting export
- `src/utils/hooks/usePageRouting.ts` - DELETED (functionality moved to navigationStore in Plan 01)

## Decisions Made
- App.tsx owns `pendingTaskId` consumption since TaskDetail is rendered there, not inside KanbanView
- `effectiveAgentId` pattern in AgentsView: pendingAgentId overrides the prop when set, falls back to prop otherwise
- WorktreesView triggers the existing `onWorktreeClick` callback to simulate selection, since WorktreeManager doesn't have a highlight prop

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. All three files updated cleanly, build passed on first attempt, 17/17 navigationStore tests passing.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Navigation system fully operational: `navigate({ taskId: '123' })` from any component will switch to kanban view and open the TaskDetail sheet
- `navigate({ agentId: '5' })` switches to agents view with the target agent selected
- `navigate({ worktreeId: '2' })` switches to worktrees view and triggers selection
- Sub-view switching (`navigate({ view: 'backlog' })`) changes KanbanView sub-view via store
- Phase 23 complete (2/2 plans)

---
*Phase: 23-add-in-app-routing-for-deep-linking-to-specific-screens*
*Completed: 2026-03-28*

## Self-Check: PASSED
- All 6 files exist (1 deletion confirmed)
- All 3 task commits verified (48bc09b, 9d30c38, d4b8e6b)
