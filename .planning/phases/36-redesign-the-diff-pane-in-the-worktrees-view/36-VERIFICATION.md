---
phase: 36-redesign-the-diff-pane-in-the-worktrees-view
verified: 2026-04-01T12:50:00Z
status: human_needed
score: 11/11 automated must-haves verified
human_verification:
  - test: "Visual end-to-end of the redesigned diff pane"
    expected: "File list panel renders on the left (~200px), each entry shows status letter (M/A/D), basename, and inline +/- stats; first file is auto-selected with left-border highlight; per-file header shows full path + status + stats; clicking a different file updates header and diff body; diff mode toggle (Uncommitted/Branch diff) is completely absent; clean worktrees show 'No uncommitted changes'"
    why_human: "Layout appearance, click-to-select interaction, live 5s background refresh without bouncing selection — cannot verify rendering or interaction programmatically without a running Tauri instance"
---

# Phase 36: Redesign the Diff Pane in the Worktrees View — Verification Report

**Phase Goal:** Redesign the diff pane in the Worktrees view from a flat all-files dump to a two-column layout with a file list panel and single-file diff body, removing the diff mode toggle.
**Verified:** 2026-04-01T12:50:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Plan 01)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | parseDiffString returns status 'A' for new file diffs | VERIFIED | Test `"returns status 'A' for new file mode"` passes; implementation: `line.includes("new file mode")` sets `currentStatus = "A"` |
| 2 | parseDiffString returns status 'D' for deleted file diffs | VERIFIED | Test `"returns status 'D' for deleted file mode"` passes; implementation: `line.includes("deleted file mode")` sets `currentStatus = "D"` |
| 3 | parseDiffString returns status 'M' for modified file diffs (default) | VERIFIED | Two tests pass — explicit `"M"` case and "defaults to 'M' when no mode line present" |
| 4 | computeFileStats correctly counts insertions and deletions from hunks | VERIFIED | 5 tests in `describe("computeFileStats")` all pass; implementation counts `startsWith("+") && !startsWith("+++")` and mirror for deletions |

### Observable Truths (Plan 02)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 5 | User sees a file list panel on the left side of the diff area showing changed files | VERIFIED | `w-[200px]` div with `border-r border-border` renders `diffFiles.map((file, i)` with `key={file.fileName}` |
| 6 | Clicking a file in the list shows only that file's diff in the diff body | VERIFIED | `onClick={() => setSelectedFileIndex(i)}` + `<DiffViewer diffFile={selectedFile} loading={false} />` |
| 7 | First changed file is auto-selected when a worktree is selected | VERIFIED | `useEffect([diffFiles])` calls `setSelectedFileIndex((prev) => prev === null ? 0 : prev)` |
| 8 | Each file entry shows M/A/D status letter, basename, and +/- stats | VERIFIED | Inline flex row: `{status}` + `{basename}` + conditional `+{stats.insertions}` / `-{stats.deletions}` all in one `<div className="flex items-center gap-1.5 min-w-0">` |
| 9 | A per-file header bar shows the full path + status + stats above the diff body | VERIFIED | IIFE renders `{selectedFile.fileName}` + `{status}` + conditional insertions/deletions in `px-3 py-2 border-b` bar |
| 10 | The diff target toggle (Uncommitted/Branch diff) is gone from the UI | VERIFIED | grep confirms zero occurrences of `ToggleGroup`, `ToggleGroupItem`, `diffMode`, `setDiffMode`, `diffBranch`, `setDiffBranch`, `"Uncommitted"`, `"Branch diff"` in WorktreeManager.tsx |
| 11 | Clean worktrees show 'No uncommitted changes' with an empty file list | VERIFIED | Condition `selectedWorktree.git_status === "" && diffFiles.length === 0` renders `"No uncommitted changes"` text; empty file list panel renders empty `<div />` |

**Score:** 11/11 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/review.ts` | DiffFileWithName with optional status field | VERIFIED | Line 49: `status?: "A" \| "M" \| "D"` present |
| `src/utils/helpers/diff-utils.ts` | parseDiffString with status detection + computeFileStats helper | VERIFIED | Both functions exported; `currentStatus`, `new file mode`, `deleted file mode`, `status: currentStatus` all present |
| `src/utils/helpers/diff-utils.test.ts` | Tests for status detection and computeFileStats | VERIFIED | `describe("parseDiffString status detection")` (4 tests) and `describe("computeFileStats")` (5 tests) present; all 21 tests pass |
| `src/components/execution/WorktreeManager.tsx` | Redesigned diff pane with file list panel, per-file header, single-file rendering | VERIFIED | `selectedFileIndex`, `w-[200px]`, `DIFF_TARGET_HEAD`, `computeFileStats`, `<DiffViewer diffFile={selectedFile}` all present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/utils/helpers/diff-utils.ts` | `src/types/review.ts` | import DiffFileWithName | WIRED | Line 6: `import { DiffFileWithName, DiffHighlighterLang } from "@/types/review"` |
| `src/components/execution/WorktreeManager.tsx` | `src/utils/helpers/diff-utils.ts` | import computeFileStats | WIRED | Line 5: `import { parseDiffString, computeFileStats } from "@/lib"` — barrel re-exports from diff-utils.ts confirmed |
| `src/components/execution/WorktreeManager.tsx` | `src/components/execution/DiffViewer.tsx` | renders single selected file | WIRED | Line 409: `<DiffViewer diffFile={selectedFile} loading={false} />` |
| `src/utils/helpers/index.ts` | `src/utils/helpers/diff-utils.ts` | barrel re-export | WIRED | Line 6: `export { parseDiffString, computeFileStats } from "./diff-utils"` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `WorktreeManager.tsx` | `diffFiles` | `useWorktreeDiffQuery` → Tauri IPC → Rust git diff → `parseDiffString` | Yes — IPC calls Rust backend; `refetchInterval: 5000` keeps it live | FLOWING |
| `WorktreeManager.tsx` | `selectedFile` | Derived from `diffFiles[selectedFileIndex]` | Yes — direct array index into real parsed data | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 21 diff-utils tests pass | `pnpm test --run src/utils/helpers/diff-utils.test.ts` | 21 passed (1 file) in 776ms | PASS |
| TypeScript build succeeds | `pnpm build` | `built in 2.32s` — zero TypeScript errors | PASS |
| computeFileStats exported from @/lib barrel | `grep computeFileStats src/utils/helpers/index.ts` | Line 6 confirms export | PASS |
| Removed toggle items absent from WorktreeManager | `grep ToggleGroup\|diffMode\|...` | NONE FOUND | PASS |
| Documented commit hashes exist | `git log --oneline` | `6b0436d` (Plan 01) and `f5be6e7`, `0a56c54` (Plan 02) all present | PASS |

### Requirements Coverage

Plan 01 declared: DIFF-UTILS-01, DIFF-UTILS-02
Plan 02 declared: DIFF-UI-01, DIFF-UI-02, DIFF-UI-03

No REQUIREMENTS.md was found to cross-reference full descriptions, but the plan acceptance criteria for all five requirement IDs are satisfied by the verified artifacts and key links above.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `WorktreeManager.tsx` | 328 | `<div className="..." />` (empty div for empty file list) | Info | Renders nothing when no files — intentional placeholder, not a stub; empty state text is in the diff body column instead |

No stubs, no TODO/FIXME, no hardcoded empty returns that affect user-visible state. The `selectedFileIndex` starts as `null` but is always populated by the auto-select `useEffect` when `diffFiles` is non-empty.

### Human Verification Required

#### 1. Visual and Interactive Diff Pane Review

**Test:** Run `pnpm tauri:dev`, open a project with at least one worktree that has uncommitted changes across multiple files. Navigate to the Worktrees tab, select a dirty worktree.

**Expected:**
- A ~200px panel appears on the left showing one entry per changed file
- Each entry shows a status letter (M, A, or D) colored appropriately, the filename (basename only, truncated if long), and inline `+N -N` stats
- The first file is highlighted with a left border accent
- A header bar above the diff body shows the full file path, status letter, and +/- stats
- The diff body shows only the selected file's unified diff
- Clicking a different file in the list moves the highlight, updates the header bar, and updates the diff body
- After 5 seconds, background refresh does NOT reset selection back to the first file if the user selected a non-first file
- Selecting a clean worktree shows an empty file list and "No uncommitted changes" in the diff body
- No diff mode toggle or branch input is visible anywhere

**Why human:** Visual layout correctness, hover/click interaction feedback, stable selection across background refetches, and "No uncommitted changes" text placement all require a running Tauri app.

### Gaps Summary

No automated gaps. All 11 must-have truths verified; build passes; all 21 tests pass. One item is routed to human verification (visual/interactive correctness in the running app).

---

_Verified: 2026-04-01T12:50:00Z_
_Verifier: Claude (gsd-verifier)_
