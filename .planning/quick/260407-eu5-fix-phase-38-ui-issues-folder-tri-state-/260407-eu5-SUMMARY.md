---
phase: quick
plan: 260407-eu5
subsystem: frontend-execution-ui
tags: [file-tree, diff-viewer, checkboxes, tri-state, layout]
dependency_graph:
  requires: []
  provides: [folder-tri-state-checkboxes, inline-hunk-checkboxes, full-height-diff-panel]
  affects: [WorktreeDiffPanel, FileTree, DiffViewer]
tech_stack:
  added: []
  patterns: [tri-state-checkbox, folder-propagation, flex-fill-layout]
key_files:
  created: []
  modified:
    - src/components/execution/FileTree.tsx
    - src/components/execution/DiffViewer.tsx
    - src/components/execution/WorktreeDiffPanel.tsx
decisions:
  - Folder checkbox click calls onToggleFolder(getDescendantFiles(node)) — passes flat list of leaf paths to parent handler
  - getFolderCheckState computed at render time from checkedFiles prop (no extra state)
  - handleFolderToggle checks ALL-checked condition via every(); otherwise checks all — matches file-level toggle logic
  - Hunk strip keeps separate-element approach (no render slot in @git-diff-view) but styled with blue diff header palette
  - DiffViewer root becomes flex flex-col h-full with inner flex-1 min-h-0 wrapper around DiffView for height fill
metrics:
  duration: "2 minutes"
  completed: "2026-04-07"
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 260407-eu5: Fix Phase 38 UI Issues — Folder Tri-State Checkboxes, Inline Hunk Styling, Full-Height Diff Panel

Folder tri-state checkboxes in FileTree with parent→children propagation, hunk strip restyled to match native @@ diff line palette, and diff panel layout fixed to fill full viewport height.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add folder tri-state checkboxes and propagate toggle to children | 9a77d38 | FileTree.tsx, WorktreeDiffPanel.tsx |
| 2 | Move hunk checkboxes inline onto @@ header lines and fix diff panel full height | 608e83b | DiffViewer.tsx, WorktreeDiffPanel.tsx |

## What Was Built

### Task 1: Folder Tri-State Checkboxes

**FileTree.tsx:**
- Added `onToggleFolder?: (fileNames: string[]) => void` prop to `FileTreeProps`, threaded through `FileNode` and `DirectoryNode`
- Added `getDescendantFiles(node)` helper — recursively collects all leaf `fileName` values
- Added `getFolderCheckState(node, checkedFiles)` helper — returns `"checked"` / `"unchecked"` / `"indeterminate"` based on descendant count
- `DirectoryNode` renders a `CheckboxPrimitive.Root` (size-3.5) between the chevron and folder name when both `checkedFiles` and `onToggleFolder` are provided; click calls `onToggleFolder(getDescendantFiles(node))` with `e.stopPropagation()` to avoid toggling expand state
- Indicator shows `Check` or `Minus` icon based on folder check state

**WorktreeDiffPanel.tsx:**
- Added `handleFolderToggle(fileNames: string[])` — if all files are checked, unchecks all; otherwise checks all (adds to `stagedFiles`, clears `stagedHunks` entries)
- Passes `onToggleFolder={handleFolderToggle}` to `FileTree` in the tree view branch

### Task 2: Inline Hunk Styling + Full-Height Layout

**DiffViewer.tsx:**
- Hunk strip rows now use `bg-blue-500/8 dark:bg-blue-400/10` background with hover variant
- Header text changed to `text-blue-700 dark:text-blue-300` (native @@ header color convention)
- Spacing tightened to `gap-1.5 px-2 py-1`; outer `border-b border-border` wrapper removed
- Root div changed from `min-h-0` to `min-h-0 flex flex-col h-full`
- `DiffView` wrapped in `<div className="flex-1 min-h-0">` so it fills remaining space after hunk headers

**WorktreeDiffPanel.tsx:**
- Diff content wrapper changed from `overflow-y-auto` to `overflow-auto` so horizontal scrollbar appears at container bottom

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — purely frontend UI/layout changes, no new trust boundaries.

## Self-Check: PASSED

- [x] `src/components/execution/FileTree.tsx` — modified and committed (9a77d38)
- [x] `src/components/execution/DiffViewer.tsx` — modified and committed (608e83b)
- [x] `src/components/execution/WorktreeDiffPanel.tsx` — modified and committed in both tasks
- [x] TypeScript: zero errors (`npx tsc --noEmit` clean)
- [x] Production build: clean (`pnpm build` succeeded in 4.54s)
