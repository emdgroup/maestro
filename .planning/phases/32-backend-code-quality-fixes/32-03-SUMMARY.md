---
phase: 32-backend-code-quality-fixes
plan: 03
subsystem: database
tags: [rust, sqlite, rusqlite, dry, refactoring, transactions]

# Dependency graph
requires:
  - phase: 32-backend-code-quality-fixes
    provides: Phase 32-01 and 32-02 completed code quality fixes prior to this plan
provides:
  - get_project_with_git_conn helper in db/connection.rs for DRY project+git_conn lookup
  - TASK_SELECT centralized as pub const in models/task.rs
  - Atomic update_task with single dynamic UPDATE in SQLite transaction
  - Error logging for previously silent filter_map(r.ok()) patterns
affects: [ipc handlers, worktree_handlers, execution_handlers, review_handlers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - get_project_with_git_conn replaces copy-paste project+git_conn lookup across handlers
    - Dynamic SQL SET clause with Vec<Box<dyn ToSql>> for flexible single-statement updates
    - filter_map with match arm for logging dropped errors instead of silent skipping

key-files:
  created: []
  modified:
    - src-tauri/src/db/connection.rs
    - src-tauri/src/db/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/models/mod.rs
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/ipc/review_handlers.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/ipc/execution_handlers.rs

key-decisions:
  - "get_project_with_git_conn uses ? for both DB lookup and SSH session resolution — call sites that need fallback behavior keep the two-step approach"
  - "update_task uses Vec<Box<dyn ToSql>> for dynamic params; conn must be mut for transaction(); re-lock after commit to read back"
  - "finalize_successful_merge DB writes stay intentionally split across lock acquisitions (async git cleanup between steps)"

patterns-established:
  - "Shared project+git_conn lookup: use crate::db::get_project_with_git_conn(&app_state, project_id).await?"
  - "Shared task SELECT: use crate::models::TASK_SELECT constant"
  - "filter_map with eprintln! on Err for visible error logging instead of silent drops"

requirements-completed: [M1, M5, M6, M12, M13]

# Metrics
duration: 6min
completed: 2026-03-31
---

# Phase 32 Plan 03: Shared Helpers, Atomic Updates, and Error Logging Summary

**DRY helper get_project_with_git_conn extracted, TASK_SELECT centralized in models/task.rs, update_task atomized to single dynamic UPDATE in transaction, silent filter_map drops replaced with eprintln! logging**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-31T08:13:52Z
- **Completed:** 2026-03-31T08:19:22Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Extracted get_project_with_git_conn helper to db/connection.rs, re-exported from db/mod.rs and lib.rs; replaced 5 copy-paste blocks across worktree_handlers.rs and execution_handlers.rs
- Centralized TASK_SELECT as pub const in models/task.rs; removed duplicate local definitions from task_handlers.rs and review_handlers.rs; added to models/mod.rs pub use re-export
- Replaced 7 separate UPDATE statements in update_task with a single dynamic UPDATE built from non-None fields, wrapped in a SQLite transaction
- Added clarifying comment to finalize_successful_merge explaining intentional split writes
- Replaced 3 silent filter_map(r.ok()) patterns in list_worktrees, cleanup_zombie_worktrees, and drain_ready_queue with eprintln! logging

## Task Commits

1. **Task 1: Extract get_project_with_git_conn helper and centralize TASK_SELECT** - `253958c` (refactor)
2. **Task 2: Atomize update_task, add transaction comment, log dropped errors** - `6f301a1` (refactor)

## Files Created/Modified
- `src-tauri/src/db/connection.rs` - Added get_project_with_git_conn async helper
- `src-tauri/src/db/mod.rs` - Re-exported get_project_with_git_conn
- `src-tauri/src/lib.rs` - Re-exported get_project_with_git_conn
- `src-tauri/src/models/task.rs` - Added pub const TASK_SELECT with full column comment; updated from_row comment
- `src-tauri/src/models/mod.rs` - Added TASK_SELECT to pub use task:: line
- `src-tauri/src/ipc/task_handlers.rs` - Removed local TASK_SELECT; replaced 7 UPDATE stmts with dynamic transaction
- `src-tauri/src/ipc/review_handlers.rs` - Removed local TASK_SELECT; added clarifying comment to finalize_successful_merge
- `src-tauri/src/ipc/worktree_handlers.rs` - Replaced 4 copy-paste project+git_conn blocks; replaced 2 silent filter_map(r.ok()) with logging
- `src-tauri/src/ipc/execution_handlers.rs` - Replaced 1 copy-paste block; replaced 1 silent filter_map(r.ok()) with logging

## Decisions Made
- Call sites with fallback unwrap_or_else (list_worktrees_with_status, delete_worktree_for_task) kept two-step approach since get_project_with_git_conn uses ? and can't produce a fallback value — only the 5 sites that fail-fast were refactored
- Dynamic params for update_task use Vec<Box<dyn ToSql>> with param_refs collected as &dyn ToSql slices; this is the standard rusqlite pattern for runtime-determined parameter lists
- conn binding must be mut for transaction(); after commit the MutexGuard is consumed so a fresh lock is acquired to read the updated row back

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None - cargo check passed on first attempt for both tasks.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- M1, M5, M6, M12, M13 satisfied; 32-04 and 32-05 can proceed
- cargo check passes with no warnings or errors

## Self-Check: PASSED

- connection.rs: FOUND
- task.rs: FOUND
- Commit 253958c: FOUND
- Commit 6f301a1: FOUND

---
*Phase: 32-backend-code-quality-fixes*
*Completed: 2026-03-31*
