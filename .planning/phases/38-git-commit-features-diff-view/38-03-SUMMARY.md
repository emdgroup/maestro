---
phase: 38-git-commit-features-diff-view
plan: 03
subsystem: ui
tags: [react, diff-view, git, staging, hunk-selection, revert, shelve, alert-dialog, popover]

# Dependency graph
requires:
  - phase: 38-git-commit-features-diff-view (plan 02)
    provides: staging state (stagedFiles, stagedHunks, hasAnyStaged, handleFileToggle), useDiscardWorktreeChangesMutation, useShelveWorktreeChangesMutation
provides:
  - Hunk-level checkboxes in DiffViewer via summary strip above DiffView
  - handleHunkToggle handler wired to stagedHunks state in WorktreeDiffPanel
  - Revert button with AlertDialog confirmation dialog
  - Shelve button with Popover stash-name input
  - Both buttons disabled when nothing selected, staging state clears after success
affects: [WorktreeDiffPanel, DiffViewer]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hunk summary strip: parse @@ headers from hunks[0] and render checkboxes above DiffView (fallback when no render slot)"
    - "Controlled Popover with base-ui onOpenChange(open: boolean) signature"
    - "AlertDialogTrigger uses render= prop (base-ui pattern, not asChild)"
    - "PopoverTrigger uses render= prop (base-ui pattern, not asChild)"

key-files:
  created: []
  modified:
    - src/components/execution/DiffViewer.tsx
    - src/components/execution/WorktreeDiffPanel.tsx

key-decisions:
  - "Use hunk summary strip (fallback) above DiffView — @git-diff-view/react DiffView has no dedicated hunk header render slot"
  - "AlertDialogTrigger/PopoverTrigger use render= prop (base-ui pattern) consistent with existing usage"
  - "onHunkToggle and hunkSelection not passed when whole file is staged (stagedFiles.has(fileName)) — avoids conflicting states"

patterns-established:
  - "Hunk summary strip: parseHunkHeaders extracts @@ header lines for display with per-hunk checkboxes"

requirements-completed: [GC-02, GC-04, GC-05]

# Metrics
duration: 4min
completed: 2026-04-02
---

# Phase 38 Plan 03: Hunk Checkboxes, Revert, and Shelve Summary

**Hunk-level staging checkboxes via @@ header strip above DiffView, plus Revert (AlertDialog) and Shelve (Popover) action bar buttons wired to discard/stash mutations**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-02T11:00:48Z
- **Completed:** 2026-04-02T11:04:56Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- DiffViewer.tsx extended with `hunkSelection` and `onHunkToggle` props; renders a hunk summary strip (one row per @@ block with checkbox) above the DiffView when `onHunkToggle` is provided
- WorktreeDiffPanel.tsx gains `handleHunkToggle` and passes hunk props to DiffViewer only when the file is not fully staged
- Revert button (RotateCcw icon) opens an AlertDialog with "Discard changes?" title before calling `discardMutation.mutateAsync`
- Shelve button (Archive icon) opens a Popover with auto-filled stash name and Confirm button calling `shelveMutation.mutateAsync`
- Staging state (stagedFiles + stagedHunks) clears after successful Revert or Shelve

## Task Commits

1. **Task 1: Add hunk checkboxes to DiffViewer and wire to staging state** - `5aa7321` (feat)
2. **Task 2: Add Revert and Shelve action bar buttons with confirmation UI** - `53d9d0d` (feat)

## Files Created/Modified

- `src/components/execution/DiffViewer.tsx` - Added hunkSelection/onHunkToggle props, parseHunkHeaders helper, hunk summary strip rendering
- `src/components/execution/WorktreeDiffPanel.tsx` - Added handleHunkToggle, handleRevert, handleShelve, shelve state, AlertDialog/Popover UI for action bar buttons

## Decisions Made

- Used hunk summary strip approach (fallback) rather than inline DiffView slot — inspected `@git-diff-view/react` index.d.ts, found `renderExtendLine`/`extendData` but no dedicated hunk header render slot
- `AlertDialogTrigger` and `PopoverTrigger` use `render=` prop (base-ui pattern) consistent with existing usages in the codebase (not `asChild`)
- Hunk selection props skipped when the whole file is staged (`stagedFiles.has(fileName)`) to prevent ambiguous state where both full-file and hunk-level selections coexist

## Deviations from Plan

None — plan executed exactly as written. The approach decision in Task 1 was pre-planned (inline vs fallback strip) and resolved by reading the library type definitions.

## Issues Encountered

None.

## Known Stubs

None — all functionality is wired: hunk checkboxes toggle stagedHunks state, Revert calls discardMutation, Shelve calls shelveMutation.

## Next Phase Readiness

Phase 38 is complete (3/3 plans done). The git commit workflow is fully functional:
- File-level tri-state checkboxes (Plan 02)
- Hunk-level checkboxes via summary strip (Plan 03)
- Commit action with staging (Plan 02)
- Revert with AlertDialog confirmation (Plan 03)
- Shelve with stash name Popover (Plan 03)

---
*Phase: 38-git-commit-features-diff-view*
*Completed: 2026-04-02*
