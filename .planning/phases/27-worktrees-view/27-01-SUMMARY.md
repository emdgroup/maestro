---
phase: 27-worktrees-view
plan: 01
subsystem: api
tags: [rust, tanstack-query, worktrees, git, typescript-bindings]

# Dependency graph
requires:
  - phase: 25-backend-overhaul
    provides: WorktreeWithStatus model and list_worktrees_with_status handler
  - phase: 20-tanstack-query
    provides: TanStack Query patterns and service layer conventions
provides:
  - WorktreeWithStatus model with diff_stat field (git diff --shortstat per worktree)
  - worktree.service.ts with 4 TanStack Query hooks and worktreeQueryKeys factory
affects: [27-02, 27-03]

# Tech tracking
tech-stack:
  added: []
  patterns: [tanstack-query-service-layer, parallel-tokio-spawn-for-git-status]

key-files:
  created:
    - src/services/worktree.service.ts
  modified:
    - src-tauri/src/models/worktree.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src/types/bindings.ts

key-decisions:
  - "useWorktreesQuery polls at 5s not 2s — worktree status changes less frequently than execution status"
  - "diff_stat_map uses same parallel tokio::spawn block as status_map — one task per worktree runs both git status and git diff --shortstat concurrently"

patterns-established:
  - "Parallel git status + diff_stat in single tokio::spawn closure — return (path, status, diff_stat) tuple"

requirements-completed: [REQ-25]

# Metrics
duration: 2min
completed: 2026-03-30
---

# Phase 27 Plan 01: Worktrees View Data Layer Summary

**WorktreeWithStatus backend extended with `git diff --shortstat` per-worktree and worktree.service.ts created with 4 TanStack Query hooks**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-30T08:29:24Z
- **Completed:** 2026-03-30T08:30:49Z
- **Tasks:** 2 completed
- **Files modified:** 4

## Accomplishments

- Added `diff_stat: Option<String>` to `WorktreeWithStatus` Rust model; regenerated TypeScript bindings with `diff_stat: string | null`
- Extended `list_worktrees_with_status` parallel spawn block to run `git diff --shortstat` alongside `git status --porcelain` per worktree
- Created `src/services/worktree.service.ts` with `worktreeQueryKeys` factory and 4 hooks ready for WorktreeManager consumption

## Task Commits

Each task was committed atomically:

1. **Task 1: Add diff_stat field to WorktreeWithStatus** - `0039eb9` (feat)
2. **Task 2: Create worktree.service.ts with TanStack Query hooks** - `28456bd` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src-tauri/src/models/worktree.rs` - Added `pub diff_stat: Option<String>` field to WorktreeWithStatus
- `src-tauri/src/ipc/worktree_handlers.rs` - Extended parallel spawn to capture diff_stat per worktree; added diff_stat_map; all WorktreeWithStatus constructions now set diff_stat
- `src/types/bindings.ts` - Regenerated with `diff_stat: string | null` in WorktreeWithStatus type
- `src/services/worktree.service.ts` - New: worktreeQueryKeys, useWorktreesQuery (5s poll), useWorktreeDiffQuery, useDeleteWorktreeMutation, useCreateWorktreeMutation

## Decisions Made

- `useWorktreesQuery` uses `refetchInterval: 5000` (5 seconds) rather than 2 seconds — worktree status changes less frequently than execution status; reduces git subprocess overhead
- `diff_stat_map` is populated inside the same parallel `tokio::spawn` closure as `status_map` — avoids a second round of spawning and keeps both git calls co-located per worktree

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02 (WorktreeManager UI component) can now import `useWorktreesQuery`, `useWorktreeDiffQuery`, `useDeleteWorktreeMutation`, `useCreateWorktreeMutation` from `src/services/worktree.service.ts`
- TypeScript types are current; `WorktreeWithStatus.diff_stat` available for the diff-stat badge in the UI
- Both `cargo check` and `npx tsc --noEmit` pass

## Self-Check: PASSED

- FOUND: src-tauri/src/models/worktree.rs
- FOUND: src-tauri/src/ipc/worktree_handlers.rs
- FOUND: src/services/worktree.service.ts
- FOUND: .planning/phases/27-worktrees-view/27-01-SUMMARY.md
- FOUND commit: 0039eb9
- FOUND commit: 28456bd

---
*Phase: 27-worktrees-view*
*Completed: 2026-03-30*
