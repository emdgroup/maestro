---
phase: 56-import-modal-change-detection
plan: 02
subsystem: ui
tags: [react, typescript, tanstack-query, framer-motion, shadcn, ticketing, import-modal]

# Dependency graph
requires:
  - phase: 56-01
    provides: import_tasks, update_task_from_remote, dismiss_task_change IPC commands, RemoteIssue with priority field, updated bindings.ts
provides:
  - useFetchRemoteIssuesQuery hook with 5-min refetchInterval gated on isModalOpen
  - useImportTasksMutation, useUpdateTaskFromRemoteMutation, useDismissTaskChangeMutation hooks
  - ticketingQueryKeys query key factory
  - ImportTicketsModal component — 3-tab modal with LayoutGroup animated tab indicator
  - classifyIssues() pure function for Available/Imported/Changed derivation
  - BacklogView "Import tickets" button gated on ticketingConfig presence
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "classifyIssues() exported as pure function for testability — no IPC round-trip needed"
    - "LayoutGroup/AnimatePresence tab pattern replicated exactly from ProjectPicker.tsx"
    - "Modal gating: importModalOpen && hasTicketing before rendering ImportTicketsModal"
    - "refetchInterval: isModalOpen ? 5*60*1000 : false — polling pauses on modal close"

key-files:
  created:
    - src/components/kanban/ImportTicketsModal.tsx
    - src/components/kanban/__tests__/ImportTicketsModal.test.tsx
    - src/components/views/__tests__/BacklogView.test.tsx
  modified:
    - src/services/task.service.ts
    - src/components/views/BacklogView.tsx

key-decisions:
  - "classifyIssues() exported (not private) to enable direct unit testing without rendering the full modal"
  - "BacklogView renders ImportTicketsModal only when both hasTicketing && importModalOpen — avoids creating hook queries when no ticketing provider connected"
  - "Dialog uses showCloseButton={false} with custom X button to match ReviewModal pattern"

patterns-established:
  - "Ticketing query keys in ticketingQueryKeys factory (separate from taskQueryKeys) for namespace isolation"
  - "Pure classification logic in exported helper function — testable without DOM"

requirements-completed: [IMPT-01, IMPT-02, IMPT-03, IMPT-04, IMPT-05, IMPT-06, CHNG-01, CHNG-02]

# Metrics
duration: 5min
completed: 2026-05-24
---

# Phase 56 Plan 02: ImportTicketsModal + BacklogView import button + four TanStack Query hooks

**Three-tab import modal (Available/Imported/Changed) with Framer Motion LayoutGroup animated tab indicator, five-minute auto-refresh, label filtering, and BacklogView "Import tickets" button gated on ticketing provider presence**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-24T05:58:00Z
- **Completed:** 2026-05-24T06:03:55Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added `ticketingQueryKeys` factory and four hooks (`useFetchRemoteIssuesQuery`, `useImportTasksMutation`, `useUpdateTaskFromRemoteMutation`, `useDismissTaskChangeMutation`) to `task.service.ts`
- Created `ImportTicketsModal` with LayoutGroup animated tab pill (matching ProjectPicker pattern exactly), AnimatePresence slide transitions, Available/Imported/Changed tabs, label filter Popover, select-all checkbox, Import Selected footer button
- Exported `classifyIssues()` pure function enabling direct unit testing of CHNG-01 classification logic
- Updated `BacklogView` with Download icon import button and `useProjectTicketingConfig` gate (`hasTicketing && importModalOpen`)
- Wrote real test assertions: IMPT-01 (button visibility), CHNG-01 (classification logic with matching/mismatching timestamps)
- Full test suite: 19 files, 153 passing, 8 todo stubs

## Task Commits

Each task was committed atomically:

1. **Task 1: ticketingQueryKeys + four hooks + Wave 0 stubs** - `a15824c` (feat)
2. **Task 2: ImportTicketsModal + BacklogView + real tests** - `5b90318` (feat)

## Files Created/Modified
- `src/services/task.service.ts` - Added `RemoteIssue` import, `ticketingQueryKeys`, `useFetchRemoteIssuesQuery`, `useImportTasksMutation`, `useUpdateTaskFromRemoteMutation`, `useDismissTaskChangeMutation`
- `src/components/kanban/ImportTicketsModal.tsx` - Full implementation with 3 tabs, classification, label filter, animations
- `src/components/views/BacklogView.tsx` - Import tickets button + modal rendering + ticketingConfig gate
- `src/components/kanban/__tests__/ImportTicketsModal.test.tsx` - CHNG-01 classification tests + todo stubs
- `src/components/views/__tests__/BacklogView.test.tsx` - IMPT-01 button visibility tests

## Decisions Made
- Exported `classifyIssues()` as a named export (not private/unexported) so CHNG-01 logic can be tested directly without a full render
- Used `showCloseButton={false}` on DialogContent with custom X button in header — consistent with ReviewModal.tsx pattern
- `BacklogView` wraps both button and modal with `hasTicketing &&` gate rather than just the button — avoids mounting the modal's queries when no provider is connected

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 56 is complete: all eight requirements (IMPT-01 through CHNG-02) are implemented and tested
- Full pnpm test suite passes (19/19 files green)
- ImportTicketsModal is accessible from BacklogView for any project with a connected ticketing provider

## Self-Check: PASSED

- `grep -n "LayoutGroup" src/components/kanban/ImportTicketsModal.tsx` — returns 3 matches (import + usage)
- `grep -n 'layoutId="import-modal-active-pill"'` — returns 1 match
- `grep -n "refetchInterval.*isModalOpen ? 5 \* 60 \* 1000 : false"` — returns match in task.service.ts
- `grep -n "Import tickets" BacklogView.tsx` — returns button label
- `grep -n "hasTicketing" BacklogView.tsx` — returns conditional gate
- `pnpm test` — 19 passed, 0 failed

---
*Phase: 56-import-modal-change-detection*
*Completed: 2026-05-24*
