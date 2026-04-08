---
phase: quick-260408-guc
plan: "01"
subsystem: agents-view
tags: [reconnect, session-cleanup, agents-view, ux]
dependency_graph:
  requires: []
  provides: [reconnect-removes-failed-session]
  affects: [src/views/AgentsView.tsx]
tech_stack:
  added: []
  patterns: [fire-and-forget api call, void operator for intentional float]
key_files:
  modified:
    - src/views/AgentsView.tsx
decisions:
  - Use void api.deleteExecutionLog(execution.id) as fire-and-forget cleanup — skips deleteMutation toast, avoids triggering a second query invalidation race with the spawn mutation's own invalidation
metrics:
  duration: "0.017h"
  completed: "2026-04-08"
  tasks_completed: 1
  files_modified: 1
---

# Phase quick-260408-guc Plan 01: Reconnect Removes Failed Session Summary

**One-liner:** Reconnect now fire-and-forgets deletion of the old failed session immediately after the new session is confirmed spawned.

## What Was Built

Modified `AgentsView.tsx` `onReconnect` handler to automatically clean up the old failed execution entry after a new session successfully spawns. The `onSuccess` callback of `spawnMutation.mutate` now:

1. Sets the selected execution to the new `logId` (existing behavior).
2. Calls `void api.deleteExecutionLog(execution.id)` as fire-and-forget to remove the old failed session from the DB and sidebar list.

Also added `import { api } from "@/lib"` since AgentsView did not previously import the raw api object.

## Tasks

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Delete old failed session on successful reconnect | d30a434 | src/views/AgentsView.tsx |

## Verification

- `pnpm build` passes with 0 TypeScript errors and 0 type errors.
- `void api.deleteExecutionLog(execution.id)` is called in `onSuccess` of the spawn mutation inside `onReconnect`.
- Old session is removed only after the new session is confirmed to exist.
- No "Session deleted" toast fires — the raw api call bypasses the mutation's `onSuccess` toast.
- No duplicate sessions remain in the sidebar after reconnecting.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or trust-boundary changes introduced.

## Self-Check: PASSED

- File exists: src/views/AgentsView.tsx — FOUND
- Commit d30a434 — FOUND
