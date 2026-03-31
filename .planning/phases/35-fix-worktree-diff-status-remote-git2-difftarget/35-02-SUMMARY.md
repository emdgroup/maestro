---
phase: 35-fix-worktree-diff-status-remote-git2-difftarget
plan: "02"
subsystem: frontend
tags: [worktree, diff, ui, tanstack-query, toggle]
dependency_graph:
  requires: ["35-01"]
  provides: ["DiffTarget toggle UI in WorktreeManager", "useWorktreeDiffQuery with DiffTarget"]
  affects: ["src/services/worktree.service.ts", "src/components/execution/WorktreeManager.tsx"]
tech_stack:
  added: []
  patterns: ["controlled toggle state with base-ui ToggleGroup", "DiffTarget discriminated union from bindings"]
key_files:
  created: []
  modified:
    - src/services/worktree.service.ts
    - src/components/execution/WorktreeManager.tsx
decisions:
  - "Use onPressedChange (base-ui Toggle API) instead of onClick for ToggleGroupItem pressed state"
  - "diffBranch pre-populated from selectedWorktree.branch_name via useEffect on selection change"
  - "diffMode === 'uncommitted' guard on git_status empty check — Branch mode always shows diff"
metrics:
  duration: "0.033h (2 minutes)"
  completed_date: "2026-03-31"
  tasks_completed: 2
  files_modified: 2
---

# Phase 35 Plan 02: Frontend DiffTarget Toggle UI Summary

DiffTarget segmented toggle (Uncommitted / Branch diff) wired from WorktreeManager to useWorktreeDiffQuery, with branch input pre-populated from the selected worktree's branch_name.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Update useWorktreeDiffQuery to accept DiffTarget | 7317465 | src/services/worktree.service.ts |
| 2 | Add diff target toggle UI to WorktreeManager detail panel | 6f01d58 | src/components/execution/WorktreeManager.tsx |

## What Was Built

**Task 1 — worktree.service.ts:**
- Imported `DiffTarget` type from `@/types/bindings`
- Updated `worktreeQueryKeys.diff` factory to include `diffTarget` in key tuple for proper cache separation per target
- Updated `useWorktreeDiffQuery(worktreeId, diffTarget)` — `diffTarget` is required (no default), passed directly to `api.getWorktreeDiff`

**Task 2 — WorktreeManager.tsx:**
- Added `useEffect`, `ToggleGroup`, `ToggleGroupItem`, `DiffTarget` imports
- Added `diffMode: "uncommitted" | "branch"` and `diffBranch: string` state
- `useEffect` pre-populates `diffBranch` from `selectedWorktree.branch_name` on selection change
- Computes `diffTarget: DiffTarget` from state: `{ type: "Head" }` or `{ type: "Branch", branch: diffBranch }`
- Passes `diffTarget` to `useWorktreeDiffQuery` — switching modes triggers re-fetch with new cache key
- Diff target selector row added between detail header and diff body: segmented ToggleGroup + conditional Input for branch name
- "No uncommitted changes" guard conditioned on `diffMode === "uncommitted"` to allow Branch mode to show diff even with clean working tree

## Verification

- `npx tsc --noEmit`: 0 errors
- `pnpm build`: succeeded (6.33s)
- All grep checks pass: DiffTarget in service, diffMode state, ToggleGroupItem, diffTarget passed to query

## Deviations from Plan

None — plan executed exactly as written, except `onClick` in plan UI example was replaced with `onPressedChange` to correctly match the base-ui Toggle primitive API.

## Self-Check: PASSED

Files exist:
- src/services/worktree.service.ts: FOUND
- src/components/execution/WorktreeManager.tsx: FOUND

Commits exist:
- 7317465: FOUND
- 6f01d58: FOUND
