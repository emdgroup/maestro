---
phase: 38-git-commit-features-diff-view
plan: 01
subsystem: ui
tags: [diff, git, typescript, rust, tauri, vitest, tdd]

requires:
  - phase: 37-redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel
    provides: WorktreeDiffPanel, parseDiffString, DiffFileWithName, get_worktree_diff, run_git_in_dir

provides:
  - extractHunkPatch function for single-hunk unified diff patch extraction
  - countHunks function for counting @@ hunk headers
  - stage_worktree_files IPC command (whole files + patch apply --cached)
  - commit_worktree IPC command
  - discard_worktree_changes IPC command (reset+checkout for files, apply --reverse for patches)
  - shelve_worktree_changes IPC command (git stash push)
  - Regenerated TypeScript bindings with 4 new commands

affects: [38-02, 38-03, diff-panel, worktree-actions]

tech-stack:
  added: []
  patterns:
    - "TDD red-green pattern: write failing tests first, implement to pass"
    - "Temp-file pattern for git apply --cached (run_git_in_dir has no stdin support)"
    - "3-step DB lookup pattern: JOIN query -> get_project_with_git_conn -> construct abs path"

key-files:
  created: []
  modified:
    - src/utils/helpers/diff-utils.ts
    - src/utils/helpers/diff-utils.test.ts
    - src/utils/helpers/index.ts
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts

key-decisions:
  - "Write patch to temp file and pass path to git apply --cached — run_git_in_dir does not support stdin"
  - "discard_worktree_changes unstages first (git reset HEAD) then discards (git checkout) to handle staged files correctly"
  - "shelve_worktree_changes uses git stash push -m with optional -- file_paths to limit scope"

patterns-established:
  - "extractHunkPatch: split on @@, collect header lines and hunk blocks separately, join for target index"
  - "countHunks: single regex match /^@@/gm — cheap, handles multi-hunk diffs"
  - "Temp patch file lifecycle: write -> git apply -> remove (remove is best-effort)"

requirements-completed: [GC-06, GC-08]

duration: 5min
completed: 2026-04-02
---

# Phase 38 Plan 01: Git Commit Features — Foundation Summary

**extractHunkPatch/countHunks diff-utils functions with 8 new tests, plus 4 Rust IPC commands (stage/commit/discard/shelve) wired into TypeScript bindings**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-02T10:47:19Z
- **Completed:** 2026-04-02T10:52:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Added `extractHunkPatch` and `countHunks` to diff-utils.ts with 8 new test cases (all 30 diff-utils tests pass)
- Implemented 4 Rust IPC commands in worktree_handlers.rs following the established 3-step DB lookup pattern
- Registered all 4 commands in lib.rs collect_commands! macro and regenerated TypeScript bindings

## Task Commits

1. **Task 1: Add extractHunkPatch and countHunks to diff-utils with tests** - `6dfc59f` (feat + test, TDD)
2. **Task 2: Add 4 Rust IPC commands for git staging workflow** - `5319d03` (feat)

## Files Created/Modified
- `src/utils/helpers/diff-utils.ts` - Added extractHunkPatch and countHunks exports
- `src/utils/helpers/diff-utils.test.ts` - Added 8 new test cases in extractHunkPatch and countHunks describe blocks
- `src/utils/helpers/index.ts` - Re-export line updated to include extractHunkPatch and countHunks
- `src-tauri/src/ipc/worktree_handlers.rs` - Added 4 new IPC command functions (stage_worktree_files, commit_worktree, discard_worktree_changes, shelve_worktree_changes)
- `src-tauri/src/lib.rs` - Registered 4 new commands in collect_commands! macro
- `src/types/bindings.ts` - Regenerated with stageWorktreeFiles, commitWorktree, discardWorktreeChanges, shelveWorktreeChanges

## Decisions Made
- Write patch content to a temp file before calling `git apply --cached` — `run_git_in_dir` does not support stdin, so patch must be passed as a file path argument
- `discard_worktree_changes` performs `git reset HEAD -- files` before `git checkout -- files` to handle files that may be staged; this two-step is required for correct discard behavior
- Temp file removal is best-effort (`let _ = std::fs::remove_file`) — failure to clean up does not abort the operation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 can now use `stageWorktreeFiles`, `commitWorktree`, `discardWorktreeChanges`, `shelveWorktreeChanges` from TypeScript bindings
- Plan 02 can use `extractHunkPatch` and `countHunks` from `@/utils/helpers` for hunk-level staging UI
- Plan 03 can use the same IPC commands for action bar integration

---
*Phase: 38-git-commit-features-diff-view*
*Completed: 2026-04-02*
