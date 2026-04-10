---
phase: 40-ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup
plan: 00
subsystem: testing
tags: [vitest, testing-library, react, hooks, wave0]

# Dependency graph
requires: []
provides:
  - Wave 0 test stub for DisconnectBackdrop component (5 test cases)
  - Wave 0 test stub for useConnectionHealth hook (8 test cases)
affects:
  - 40-03 (implements DisconnectBackdrop and useConnectionHealth that these stubs target)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wave 0 test-first: write failing test contracts before implementation exists"
    - "vi.mock with manual listener registry for Tauri event simulation"
    - "emitMockEvent helper function to trigger fake Tauri backend events in hook tests"

key-files:
  created:
    - src/components/common/__tests__/DisconnectBackdrop.test.tsx
    - src/utils/hooks/__tests__/useConnectionHealth.test.ts
  modified: []

key-decisions:
  - "Wave 0 test stubs intentionally fail — they establish behavioral contracts for Plan 03 implementors"
  - "useConnectionHealth.test.ts uses vi.mock module-level hoisting with a mutable mockListeners registry so emitMockEvent can trigger handlers synchronously in act() blocks"
  - "Tests placed in __tests__/ subdirectories matching the project's existing component test pattern (src/components/project-picker/__tests__/)"

patterns-established:
  - "Tauri event mock pattern: const mockListeners registry + vi.mock(@tauri-apps/api/event) + emitMockEvent helper"

requirements-completed: [SSH-FE-01, SSH-FE-02, SSH-FE-03]

# Metrics
duration: 3min
completed: 2026-04-10
---

# Phase 40 Plan 00: Wave 0 Test Stubs Summary

**Vitest stub files for DisconnectBackdrop (5 tests) and useConnectionHealth (8 tests) establishing behavioral contracts before Plan 03 implementation**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-10T13:00:42Z
- **Completed:** 2026-04-10T13:03:20Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Created `DisconnectBackdrop.test.tsx` with 5 test cases: lost state render, reconnecting state with counter, failed state with dismiss button, dismiss callback invocation, and dismiss-button absence in non-failed states
- Created `useConnectionHealth.test.ts` with 8 test cases: initial connected state, null connectionId no-op guard, lost/reconnecting/reconnected/failed Tauri event transitions, cross-connection ID filtering, and dismiss reset
- Established a reusable Tauri event mock pattern using a mutable `mockListeners` registry with `emitMockEvent` helper, enabling synchronous act()-wrapped event simulation

## Task Commits

Each task was committed atomically:

1. **Task 1: Create test stubs for DisconnectBackdrop and useConnectionHealth** - `f3b9965` (test)

**Plan metadata:** _(see final metadata commit below)_

## Files Created/Modified
- `src/components/common/__tests__/DisconnectBackdrop.test.tsx` - 5 failing test stubs for the disconnect backdrop component
- `src/utils/hooks/__tests__/useConnectionHealth.test.ts` - 8 failing test stubs for the connection health hook

## Decisions Made
- Wave 0 tests are intentionally failing stubs — they encode behavioral contracts that Plan 03 must satisfy
- Used `vi.mock` at module scope with mutable `mockListeners` object so mock state persists across test lifecycle (cleared in `beforeEach`); this is the correct Vitest hoisting pattern for async event mocks
- `emitMockEvent` is a plain helper (not a mock itself) that synchronously invokes registered Tauri event handlers — lets tests use `act()` without async await overhead

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Wave 0 test contracts are in place; Plan 03 can now implement DisconnectBackdrop and useConnectionHealth and run `pnpm test` to verify behavioral correctness against these stubs
- Tests will fail with "Cannot find module '../DisconnectBackdrop'" and "Cannot find module '../useConnectionHealth'" until Plan 03 creates those files

---
*Phase: 40-ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup*
*Completed: 2026-04-10*
