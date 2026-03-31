---
phase: 34-remove-node-sidecar-implement-squash-merge-in-rust
plan: 01
subsystem: git
tags: [rust, git, subprocess, squash-merge, tokio]

# Dependency graph
requires:
  - phase: 33-tauri-backend-code-review-refactoring
    provides: finalize_successful_merge, reject_merge_on_conflict helpers in review_handlers.rs
provides:
  - squash_merge_to_main function in git/mod.rs performing local squash merge via subprocess
  - parse_conflict_files helper detecting UU/AA/DD/AU/UA/DU/UD conflict codes
  - approve_task_and_merge updated to call git::squash_merge_to_main directly (no Node.js)
affects: [34-02-remove-sidecar-cleanup, sidecar, review-workflow]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - squash_merge_to_main is pub but NOT dispatched through GitConnection enum — operates on local repo path always
    - checkout → squash merge --no-commit → status --porcelain → commit sequence
    - parse_conflict_files uses XY code inspection: U (unmerged), AA (both added), DD (both deleted)

key-files:
  created: []
  modified:
    - src-tauri/src/git/mod.rs
    - src-tauri/src/ipc/review_handlers.rs

key-decisions:
  - "squash_merge_to_main is pub but not dispatched through GitConnection — worktrees are always local even for remote projects, so squash merge always runs on local repo path"
  - "Do not check output.status.success() after git merge --squash --no-commit — non-zero exit is expected on conflicts, handled by subsequent git status --porcelain"
  - "MergeOutcome removed from review_handlers.rs imports — no longer needed after eliminating sidecar JSON parsing"

patterns-established:
  - "Parse conflict XY codes: xy.contains('U') || xy == 'AA' || xy == 'DD'"
  - "Abort merge on conflict via git merge --abort (best-effort, ignore error)"

requirements-completed: [SM-01, SM-02]

# Metrics
duration: 2min
completed: 2026-03-31
---

# Phase 34 Plan 01: Squash Merge in Native Rust Summary

**Squash merge to main implemented as native Rust subprocess chain, replacing the Node.js sidecar invocation in approve_task_and_merge**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-31T13:09:32Z
- **Completed:** 2026-03-31T13:11:41Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Implemented `squash_merge_to_main` in `git/mod.rs` with full conflict detection and abort logic
- Added `parse_conflict_files` private helper parsing `git status --porcelain` XY conflict codes
- Replaced `tokio::process::Command::new("node")` sidecar block in `approve_task_and_merge` with `git::squash_merge_to_main` call
- Removed `MergeOutcome` import and `serde_json::from_str` deserialization from `review_handlers.rs`
- `cargo check` passes with zero errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement squash_merge_to_main in git/mod.rs** - `853b4ed` (feat)
2. **Task 2: Replace sidecar callsite in approve_task_and_merge** - `a1db38e` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src-tauri/src/git/mod.rs` - Added `squash_merge_to_main` (pub, not through GitConnection dispatch) and `parse_conflict_files` helper; added `use crate::models::MergeResult`
- `src-tauri/src/ipc/review_handlers.rs` - Removed MergeOutcome import, replaced sidecar block with `git::squash_merge_to_main` call, updated doc comment

## Decisions Made
- `squash_merge_to_main` is `pub` but bypasses the GitConnection dispatcher: worktrees are always local even for remote projects, so the squash merge always runs on the local repo path. Remote dispatch would be wrong here.
- Do not check `output.status.success()` after `git merge --squash --no-commit` — git returns non-zero when there are conflicts, which is an expected outcome handled by the subsequent `git status --porcelain` step.
- `MergeOutcome` is no longer referenced anywhere in `review_handlers.rs`. The type is still defined in `models/merge_outcome.rs` and will be deleted in Plan 02 (sidecar cleanup).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - squash_merge_to_main is fully wired: approve_task_and_merge calls it directly, MergeResult flows back to the caller.

## Next Phase Readiness
- Plan 01 complete: Node.js sidecar is no longer invoked at runtime
- Plan 02 can now safely delete the sidecar directory, `MergeOutcome` model, and any remaining sidecar references

---
*Phase: 34-remove-node-sidecar-implement-squash-merge-in-rust*
*Completed: 2026-03-31*
