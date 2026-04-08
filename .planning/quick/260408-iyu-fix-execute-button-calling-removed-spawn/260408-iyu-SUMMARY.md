---
phase: quick-260408-iyu
plan: "01"
subsystem: kanban
tags: [bug-fix, navigation, ux]
dependency_graph:
  requires: []
  provides: [working-execute-button-on-ready-tasks]
  affects: [src/components/kanban/TaskCard.tsx]
tech_stack:
  added: []
  patterns: [navigate-via-navigationStore]
key_files:
  created: []
  modified:
    - src/components/kanban/TaskCard.tsx
decisions:
  - "Replace execute IPC call with navigate to Agents tab — spawn_agent_execution was intentionally removed in Phase 34; the new flow is to start sessions from AgentsView using spawnInteractiveExecution"
  - "Show toast.info (not toast.error) on button click — the action is not an error, it is guidance to where the user should go"
  - "Rename button label to 'Open Agents' — accurately describes the new behavior without confusing users"
metrics:
  duration: "~3 minutes"
  completed: "2026-04-08"
  tasks_completed: 1
  files_modified: 1
---

# Phase quick-260408-iyu Plan 01: Fix Execute Button Calling Removed Spawn Summary

**One-liner:** Replace broken `executeTask` IPC call in TaskCard with `navigate({ view: "agents" })` and an informative toast.

## What Was Built

The Execute button on Ready task cards was calling `store.executeTask()`, which intentionally throws `"spawn_agent_execution has been removed. Use spawnInteractiveExecution instead."` The button now navigates the user to the Agents tab and shows a `toast.info` message directing them to start a session there.

## Changes Made

**`src/components/kanban/TaskCard.tsx`**

- Added `import { useNavigate } from "@/store/navigationStore"` 
- Added `const navigate = useNavigate()` inside the component
- Replaced async `handleExecute` (which called `store.executeTask`) with a synchronous version that calls `navigate({ view: "agents" })` and `toast.info(...)`
- Removed `isExecuting` state variable and all `setIsExecuting` calls
- Removed `disabled={isExecuting}` and conditional CSS class from the button
- Renamed button label from `{isExecuting ? "Executing..." : "Execute"}` to `"Open Agents"`

## Verification

- Build: `pnpm build` completed with 0 TypeScript errors
- `grep -n "isExecuting" TaskCard.tsx` returns no results
- `grep -n "navigate.*agents" TaskCard.tsx` returns line 89: `navigate({ view: "agents" })`

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None. Navigation is a local synchronous store update with no external calls or new attack surface.

## Self-Check: PASSED

- File modified: `src/components/kanban/TaskCard.tsx` - EXISTS
- Commit `b5e7292` - EXISTS (`fix(quick-260408-iyu-01): replace broken handleExecute with navigate to Agents tab`)
