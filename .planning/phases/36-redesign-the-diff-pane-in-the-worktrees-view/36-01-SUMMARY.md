---
phase: 36-redesign-the-diff-pane-in-the-worktrees-view
plan: 01
subsystem: ui
tags: [diff, typescript, vitest, testing, diff-utils]

requires: []
provides:
  - "DiffFileWithName.status field ('A' | 'M' | 'D') — file status from diff header"
  - "parseDiffString extended with new/deleted file mode detection"
  - "computeFileStats helper — counts insertions/deletions from hunk lines"
affects:
  - 36-02-PLAN.md

tech-stack:
  added: []
  patterns:
    - "TDD: RED (9 failing tests) then GREEN (all 21 pass) pattern"
    - "status detection reads pre-hunk header lines, resets per-file at diff --git boundary"
    - "computeFileStats guards against +++ and --- header lines with not-startsWith check"

key-files:
  created: []
  modified:
    - src/types/review.ts
    - src/utils/helpers/diff-utils.ts
    - src/utils/helpers/diff-utils.test.ts

key-decisions:
  - "status field is optional on DiffFileWithName (not required) — parseDiffString always sets it, but type flexibility preserved for manual construction"
  - "currentStatus initialized to 'M' inside diff --git branch (reset per file) — defaults to modified when no mode line present"
  - "computeFileStats does not rely on parseDiffString stripping +++ / --- lines — guards itself for correctness even with raw hunk input"

patterns-established:
  - "Status detection: scan lines between diff --git and first @@ for 'new file mode' / 'deleted file mode'"
  - "Stat counting: startsWith('+') && !startsWith('+++') for insertions; same pattern for deletions"

requirements-completed:
  - DIFF-UTILS-01
  - DIFF-UTILS-02

duration: 4min
completed: 2026-04-01
---

# Phase 36 Plan 01: Diff Utility Extensions Summary

**parseDiffString extended with A/M/D status detection; computeFileStats helper added counting insertions/deletions from unified diff hunks**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-01T12:03:16Z
- **Completed:** 2026-04-01T12:07:00Z
- **Tasks:** 1 (TDD)
- **Files modified:** 3

## Accomplishments

- Added `status?: "A" | "M" | "D"` to `DiffFileWithName` interface
- Extended `parseDiffString` to detect `new file mode` / `deleted file mode` header lines and set per-file status (defaults to `"M"`)
- Added `computeFileStats(hunks: string[]): { insertions: number; deletions: number }` exported from diff-utils.ts
- 9 new unit tests added; all 21 tests pass (12 pre-existing + 9 new); TypeScript build verified

## Task Commits

Each task was committed atomically:

1. **Task 1: Add status field, extend parseDiffString, add computeFileStats** - `6b0436d` (feat)

**Plan metadata:** (docs commit follows)

_Note: TDD task — RED (9 failing) confirmed before GREEN implementation_

## Files Created/Modified

- `src/types/review.ts` — Added `status?: "A" | "M" | "D"` to `DiffFileWithName`
- `src/utils/helpers/diff-utils.ts` — Extended `parseDiffString` with status tracking; added `computeFileStats`
- `src/utils/helpers/diff-utils.test.ts` — Added `parseDiffString status detection` and `computeFileStats` describe blocks (9 tests)

## Decisions Made

- `status` is optional on the type to avoid breaking existing callers that construct `DiffFileWithName` manually, but `parseDiffString` always populates it
- `currentStatus` resets to `"M"` inside the `diff --git` branch so each file gets an independent default
- `computeFileStats` self-guards against `+++` / `---` lines — does not assume they are pre-stripped by the caller

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `DiffFileWithName.status` and `computeFileStats` are ready for Plan 02 (file list panel and per-file header bar)
- No blockers

## Self-Check

- [x] `src/types/review.ts` contains `status?: "A" | "M" | "D"`
- [x] `src/utils/helpers/diff-utils.ts` exports `computeFileStats`
- [x] `parseDiffString` contains `currentStatus`, `new file mode`, `deleted file mode`, `status: currentStatus` in push calls
- [x] Test file contains `describe("parseDiffString status detection"` and `describe("computeFileStats"`
- [x] All 21 tests pass
- [x] TypeScript build succeeds

---
*Phase: 36-redesign-the-diff-pane-in-the-worktrees-view*
*Completed: 2026-04-01*
