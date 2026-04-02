---
phase: 38-git-commit-features-diff-view
plan: 02
subsystem: ui
tags: [react, tanstack-query, checkbox, git-staging, diff-panel]

# Dependency graph
requires:
  - phase: 38-01
    provides: IPC commands (stage_worktree_files, commit_worktree, discard_worktree_changes, shelve_worktree_changes) and bindings

provides:
  - 4 TanStack mutation hooks in worktree.service.ts for stage/commit/discard/shelve
  - 3-state file checkboxes (checked/unchecked/indeterminate) in WorktreeDiffPanel flat file list
  - 3-state file checkboxes in FileTree tree mode via checkedFiles/onToggleFile props
  - Conditional commit area (Textarea + Commit button) at bottom of file list panel
  - handleCommit flow: stage files → commit → clear state → close panel if all committed

affects: [38-03, WorktreeDiffPanel, FileTree, worktree.service]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "@base-ui/react/checkbox CheckboxPrimitive.Root with indeterminate prop for tri-state checkboxes"
    - "e.stopPropagation() on checkbox span prevents file selection from firing on checkbox click"
    - "stagedFiles (Set<string>) tracks whole-file staging; stagedHunks (Map<string, Set<number>>) tracks hunk-level"
    - "hasAnyStaged derived state drives conditional commit area visibility"

key-files:
  created: []
  modified:
    - src/services/worktree.service.ts
    - src/components/execution/WorktreeDiffPanel.tsx
    - src/components/execution/FileTree.tsx

key-decisions:
  - "Use CheckboxPrimitive.Root directly (not Checkbox wrapper) to access indeterminate prop"
  - "Staging state resets on worktreeId change to prevent cross-worktree state bleed"
  - "onClose() called after commit only when all files were staged (filesToStage.length === diffFiles.length)"

patterns-established:
  - "FileTree accepts optional checkedFiles Map and onToggleFile prop; renders checkboxes only when both provided"
  - "Checkbox stopPropagation pattern: wrap CheckboxPrimitive.Root in a span that calls e.stopPropagation()"

requirements-completed: [GC-01, GC-03, GC-07]

# Metrics
duration: 8min
completed: 2026-04-02
---

# Phase 38 Plan 02: File Checkboxes and Commit Flow Summary

**3-state file checkboxes (unchecked/indeterminate/checked) in both flat and tree file list modes, with a conditional commit area that stages selected files and commits, clearing state and closing the diff panel on full commit**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-02T10:53:00Z
- **Completed:** 2026-04-02T11:01:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Added 4 TanStack mutation hooks (`useStageWorktreeFilesMutation`, `useCommitWorktreeMutation`, `useDiscardWorktreeChangesMutation`, `useShelveWorktreeChangesMutation`) to `worktree.service.ts`
- Implemented 3-state file checkboxes in `WorktreeDiffPanel` flat file list using `@base-ui/react/checkbox` `CheckboxPrimitive.Root` with `indeterminate` prop
- Extended `FileTree` with optional `checkedFiles` and `onToggleFile` props, threading them to leaf `FileNode` for tree mode checkbox support
- Added conditional commit area (Textarea + Commit button) at bottom of file list panel, visible only when `hasAnyStaged` is true
- Commit flow: stage selected files → run git commit → clear staging state → close panel if all files were committed

## Task Commits

Each task was committed atomically:

1. **Task 1: Add 4 TanStack mutation hooks to worktree.service.ts** - `6c058e8` (feat)
2. **Task 2: Add file checkboxes and commit area to WorktreeDiffPanel + FileTree** - `9e2f5b6` (feat)

## Files Created/Modified
- `src/services/worktree.service.ts` - 4 new mutation hooks for stage/commit/discard/shelve
- `src/components/execution/WorktreeDiffPanel.tsx` - stagedFiles/stagedHunks state, getFileCheckState, handleFileToggle, handleCommit, checkboxes in flat list, commit area
- `src/components/execution/FileTree.tsx` - checkedFiles + onToggleFile props threaded through DirectoryNode/FileNode hierarchy

## Decisions Made
- Used `CheckboxPrimitive.Root` directly rather than the `Checkbox` wrapper component because the wrapper doesn't expose the `indeterminate` prop
- Wrapped checkbox in a `<span onClick={e.stopPropagation()}>` to prevent file selection from firing when clicking the checkbox
- Staging state (`stagedFiles`, `stagedHunks`, `commitMessage`) resets in the `worktreeId` useEffect to prevent cross-worktree state bleed
- `onClose()` is called only when `filesToStage.length === diffFiles.length && !combinedPatch` — partial commits leave the panel open with remaining files

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failures in `ProjectPicker.test.tsx` (13 tests, `No QueryClient set` error) — confirmed pre-existing before these changes, out of scope.

## Next Phase Readiness
- Plan 38-02 complete: file-level staging checkboxes and commit flow fully implemented
- Plan 38-03 can now build on this: hunk-level staging from the diff pane (stagedHunks state already in place)

---
*Phase: 38-git-commit-features-diff-view*
*Completed: 2026-04-02*
