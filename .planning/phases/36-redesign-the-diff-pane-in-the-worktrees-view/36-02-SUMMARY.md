---
phase: 36-redesign-the-diff-pane-in-the-worktrees-view
plan: "02"
subsystem: frontend/worktrees
tags: [diff-pane, worktrees, ui, file-list, navigation]
dependency_graph:
  requires: ["36-01"]
  provides: ["redesigned-diff-pane"]
  affects: ["src/components/execution/WorktreeManager.tsx"]
tech_stack:
  added: []
  patterns:
    - "Module-level constant for stable query key (DIFF_TARGET_HEAD outside component)"
    - "IIFE pattern for inline derived JSX with local variables (per-file header)"
    - "Auto-select first file via useEffect on diffFiles change"
key_files:
  created: []
  modified:
    - src/components/execution/WorktreeManager.tsx
    - src/utils/helpers/index.ts
decisions:
  - "Always use DiffTarget::Head — diff target toggle removed; branch diff added unnecessary UI complexity"
  - "Module-level DIFF_TARGET_HEAD constant avoids query key object recreation on every render"
  - "IIFE for per-file header bar to keep local stat/status variables scoped without extracting a component"
metrics:
  duration_hours: 0.033
  completed_date: "2026-04-01"
  tasks_completed: 1
  tasks_total: 2
  files_modified: 2
---

# Phase 36 Plan 02: Diff Pane Redesign — File List + Per-File Header Summary

**One-liner:** Two-column diff pane with 200px file list (M/A/D status + basename + stats), per-file header bar, and single-file rendering replacing all-at-once diff scroll.

## Tasks Completed

| # | Task | Commit | Status |
|---|------|--------|--------|
| 1 | Refactor WorktreeManager — file list panel, per-file header, single-file rendering | f5be6e7 | DONE |
| 2 | Visual verification of diff pane redesign | — | CHECKPOINT (awaiting human verify) |

## What Was Built

### Task 1 — WorktreeManager.tsx Redesign

**Removals:**
- `ToggleGroup` / `ToggleGroupItem` import and usage deleted
- `diffMode` and `setDiffMode` state removed
- `diffBranch` and `setDiffBranch` state removed
- `useEffect` pre-populating `diffBranch` from `selectedWorktree.branch_name` removed
- `diffTarget` derived constant removed
- "Diff target selector" JSX block (Uncommitted/Branch diff toggle + branch input) removed
- `diffFiles.map(...)` all-at-once rendering pattern removed

**Additions:**
- `const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" }` module-level constant
- `computeFileStats` added to `@/lib` barrel (`src/utils/helpers/index.ts`)
- `computeFileStats` import added to WorktreeManager
- `const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null)`
- `useEffect` auto-selects first file when `diffFiles` changes
- `const selectedFile` derived from `diffFiles[selectedFileIndex]`
- 200px file list panel showing M/A/D status letter, basename, +/- stats per file
- Per-file header bar with full path, status letter, and +/- stats above diff body
- Single-file `<DiffViewer diffFile={selectedFile} loading={false} />` rendering
- Clean worktree shows "No uncommitted changes" (git_status empty + no diffFiles)

## Deviations from Plan

**1. [Rule 2 - Missing Export] Added `computeFileStats` to `@/lib` barrel**
- **Found during:** Task 1 pre-analysis
- **Issue:** `computeFileStats` was defined in `diff-utils.ts` but not re-exported from the `@/lib` barrel (`src/utils/helpers/index.ts`). The plan instructed importing it from `@/lib`.
- **Fix:** Added `computeFileStats` to the export in `index.ts` alongside `parseDiffString`.
- **Files modified:** `src/utils/helpers/index.ts`
- **Commit:** f5be6e7

## Acceptance Criteria Verification

- [x] WorktreeManager.tsx does NOT contain `ToggleGroup` or `ToggleGroupItem`
- [x] WorktreeManager.tsx does NOT contain `diffMode` or `setDiffMode`
- [x] WorktreeManager.tsx does NOT contain `diffBranch` or `setDiffBranch`
- [x] WorktreeManager.tsx does NOT contain `"Uncommitted"` or `"Branch diff"` string literals
- [x] WorktreeManager.tsx contains `const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" }` outside the component
- [x] WorktreeManager.tsx contains `const [selectedFileIndex, setSelectedFileIndex] = useState`
- [x] WorktreeManager.tsx contains `computeFileStats` (imported and used)
- [x] WorktreeManager.tsx contains `w-[200px]` (file list panel width)
- [x] WorktreeManager.tsx contains `selectedFile.fileName` (per-file header rendering)
- [x] WorktreeManager.tsx contains `diffFiles.map((file, i)` with `key={file.fileName}`
- [x] WorktreeManager.tsx contains `<DiffViewer diffFile={selectedFile}`
- [x] pnpm build exits 0

## Known Stubs

None.

## Self-Check: PASSED
- f5be6e7 exists in git log
- src/components/execution/WorktreeManager.tsx exists and contains all required patterns
- src/utils/helpers/index.ts exports computeFileStats
