---
phase: 27-worktrees-view
plan: "02"
subsystem: frontend
tags: [worktrees, sidebar, ui, react, tanstack-query]
dependency_graph:
  requires: [27-01]
  provides: [WorktreeManager sidebar list, WorktreesView data owner]
  affects: [src/App.tsx, src/views/WorktreesView.tsx, src/components/execution/WorktreeManager.tsx]
tech_stack:
  added: []
  patterns: [AgentMonitor layout pattern, TanStack Query data ownership, navigationStore deep links]
key_files:
  created: []
  modified:
    - src/components/execution/WorktreeManager.tsx
    - src/views/WorktreesView.tsx
    - src/App.tsx
decisions:
  - WorktreeManager accepts worktrees as props (pure display component matching AgentMonitor pattern)
  - Filter logic: Active=agent_status running, Modified=non-empty git_status, Idle=not running + clean
  - Status dot color: green (bg-success) for clean worktree, yellow (bg-warning) for dirty
  - repoPath prop passed from App.tsx via currentProject.path for useWorktreesQuery
metrics:
  duration_hours: 0.019
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 3
---

# Phase 27 Plan 02: Worktrees Sidebar List + Data Wiring Summary

**One-liner:** Sidebar list with real WorktreeWithStatus data, filter toolbar, zombie/orphan badges, and task deep links — matching AgentMonitor layout exactly.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Rewrite WorktreeManager as sidebar list + right panel shell | e5c2d7e | src/components/execution/WorktreeManager.tsx |
| 2 | Rewrite WorktreesView and update App.tsx props | ca0ba15 | src/views/WorktreesView.tsx, src/App.tsx |

## What Was Built

**WorktreeManager.tsx** — complete rewrite:
- `flex h-full` outer layout matching AgentMonitor exactly
- `w-72` sidebar with header, filter toolbar, and scrollable list
- Filter toolbar: Input for branch search + ToggleGroup with All/Active/Modified/Idle chips
- Each worktree row: status dot + branch name (monospace) + Zombie/Orphan badges
- Task name as clickable button calling `navigate({ taskId })` for cross-view deep links
- Diff shortstat line showing files changed, +insertions (green), -deletions (red)
- Two empty states: "No worktrees found" (empty data) and "No worktrees match your filter" (filtered)
- Right panel placeholder: "Select a worktree to view details"
- `parseDiffStat` helper parses git shortstat string into structured numbers

**WorktreesView.tsx** — complete rewrite:
- Owns `useWorktreesQuery(projectId, repoPath)` TanStack Query call
- Manages `selectedWorktreeId` local state
- Handles deep-link via `pendingWorktreeId` from navigationStore (same pattern as AgentsView)
- Passes `worktrees`, `selectedWorktreeId`, `onSelect`, `repoPath` to WorktreeManager

**App.tsx** — prop update:
- Replaced `worktrees={[]}` with `repoPath={currentProject.path}`
- WorktreesView now self-sufficient (no placeholder data passed from parent)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- Right panel shows "Select a worktree to view details" placeholder — detail panel content is intentionally deferred to Plan 03 as documented in the plan objective.

## Self-Check

Verified file existence:
- [x] src/components/execution/WorktreeManager.tsx — exists, 165 lines
- [x] src/views/WorktreesView.tsx — exists, 40 lines
- [x] src/App.tsx — updated with repoPath prop

Verified commits:
- [x] e5c2d7e — feat(27-02): rewrite WorktreeManager as sidebar list + right panel shell
- [x] ca0ba15 — feat(27-02): rewrite WorktreesView as data owner, update App.tsx props

TypeScript: 0 errors (npx tsc --noEmit)

## Self-Check: PASSED
