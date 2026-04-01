---
phase: quick-260401-tau
plan: 01
subsystem: worktrees-view
tags: [ui, ux, worktrees, diff-panel, polish]
dependency_graph:
  requires: [phase-37]
  provides: [TAU-01, TAU-02, TAU-03]
  affects: [WorktreeCard, WorktreesView, WorktreeDiffPanel]
tech_stack:
  added: []
  patterns: [absolute-positioning-for-centered-header, conditional-cursor-guard]
key_files:
  created: []
  modified:
    - src/components/execution/WorktreeCard.tsx
    - src/views/WorktreesView.tsx
    - src/components/execution/WorktreeDiffPanel.tsx
decisions:
  - "Gate onClick in WorktreeCard on git_status non-empty OR diff_stat non-null — prevents clean cards from opening an empty diff panel"
  - "Action bar moved inside Screen 1 of slide container so search/filters slide away when diff panel appears — cleaner single-context UI"
  - "Branch name centered via absolute inset-0 + pointer-events-none overlay; left/right controls get z-10 to stay interactive"
metrics:
  duration: 0.028h
  completed: "2026-04-01T21:09:02Z"
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 260401-tau: Fix 3 post-phase-37 UI issues in the diff pane

**One-liner:** Gate clean worktree click, slide action bar with card grid, and center branch name in diff panel header using absolute positioning.

## Objective

Three targeted UI polish fixes for the phase-37 worktrees redesign:
1. Clean worktree cards must not open the diff panel
2. Action bar must slide out with the card grid when diff panel opens
3. Branch name must be horizontally centered in the diff panel action bar

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Gate diff pane on dirty status + move action bar into slide container | a12f3e5 | WorktreeCard.tsx, WorktreesView.tsx |
| 2 | Center branch name in diff panel action bar | 7eb166b | WorktreeDiffPanel.tsx |

## Changes Made

### Task 1: Gate diff pane on dirty status and move action bar

**WorktreeCard.tsx:**
- Added `cn` import from `@/lib`
- `onClick` now guards with early return when `git_status === ""` and `diff_stat === null`
- Card className uses conditional `cursor-pointer hover:bg-muted/10` (dirty) vs `cursor-default` (clean)

**WorktreesView.tsx:**
- Removed the action bar `<div>` from between the outer container and the slide container
- Placed the action bar as the first child inside Screen 1 (`w-1/2` card grid div)
- The outer `<div className="flex flex-col h-full">` now directly wraps the slide container
- Action bar now slides out of view with the card grid when diff panel opens

### Task 2: Center branch name in diff panel action bar

**WorktreeDiffPanel.tsx:**
- Outer action bar div changed to `relative h-12 border-b ... flex items-center px-4 shrink-0`
- Branch name `<span>` removed from left group
- New absolutely-positioned center element: `absolute inset-0 flex items-center justify-center pointer-events-none`
- Left group (file search + flat/tree toggle): `flex items-center gap-2 z-10`
- Right group (unified/split toggle + close): `ml-auto flex items-center gap-2 z-10`

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

Files exist:
- src/components/execution/WorktreeCard.tsx — FOUND
- src/views/WorktreesView.tsx — FOUND
- src/components/execution/WorktreeDiffPanel.tsx — FOUND

Commits:
- a12f3e5 — FOUND
- 7eb166b — FOUND

Build: zero TypeScript errors, production bundle verified.
