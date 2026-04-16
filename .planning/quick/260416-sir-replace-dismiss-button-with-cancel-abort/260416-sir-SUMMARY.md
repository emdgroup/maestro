---
phase: quick
plan: 260416-sir
subsystem: frontend/execution
tags: [ui, disconnect-backdrop, navigation, ssh]
dependency_graph:
  requires: []
  provides: [leave-connection-navigation]
  affects: [DisconnectBackdrop, App.tsx]
tech_stack:
  added: []
  patterns: [useCallback with dismissBackdrop+clearSelectedProject]
key_files:
  created: []
  modified:
    - src/components/common/DisconnectBackdrop.tsx
    - src/components/common/__tests__/DisconnectBackdrop.test.tsx
    - src/App.tsx
decisions:
  - "handleLeaveConnection calls dismissBackdrop() before clearSelectedProject() — resets health state so backdrop does not flash on next project pick"
  - "useCallback deps are [dismissBackdrop, clearSelectedProject] — both stable references from their respective hooks/stores"
metrics:
  duration: 0.017h
  completed: "2026-04-16"
  tasks_completed: 2
  files_modified: 3
---

# Phase quick Plan 260416-sir: Replace Dismiss with Leave Connection Summary

**One-liner:** Replaced the failed-state "Dismiss" button with a "Leave Connection" button that resets connection health state and navigates to the project picker.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Replace Dismiss with Leave Connection in DisconnectBackdrop | 6c9b92a | DisconnectBackdrop.tsx, DisconnectBackdrop.test.tsx |
| 2 | Wire Leave Connection to navigate back to project picker | 37e8fae | App.tsx |

## What Was Built

### DisconnectBackdrop.tsx
- Renamed prop `onDismiss` → `onLeaveConnection`
- Changed button label "Dismiss" → "Leave Connection"
- Added `LogOut` icon (h-3.5 w-3.5 mr-1.5 inline) before label
- Updated helper text: "then try connecting again." (button itself handles navigation)

### App.tsx
- Added `useCallback` import
- Created `handleLeaveConnection` callback: calls `dismissBackdrop()` then `clearSelectedProject()`
- Passes `onLeaveConnection={handleLeaveConnection}` to DisconnectBackdrop

### DisconnectBackdrop.test.tsx
- Updated `defaultProps` to use `onLeaveConnection`
- Updated 3 tests: button name query changed to `/leave connection/i`
- Renamed test descriptions to match new behavior

## Verification

- `pnpm test DisconnectBackdrop` — 5/5 tests pass
- `pnpm build` — 0 TypeScript errors, production bundle built in 2.37s

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or security-relevant surface introduced.

## Self-Check: PASSED

- [x] src/components/common/DisconnectBackdrop.tsx — modified
- [x] src/components/common/__tests__/DisconnectBackdrop.test.tsx — modified
- [x] src/App.tsx — modified
- [x] Commit 6c9b92a exists
- [x] Commit 37e8fae exists
