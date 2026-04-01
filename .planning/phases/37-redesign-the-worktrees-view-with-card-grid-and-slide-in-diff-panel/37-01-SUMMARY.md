---
phase: 37-redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel
plan: 01
subsystem: database
tags: [rust, sqlite, schema-migration, tauri-specta, typescript-bindings]

# Dependency graph
requires:
  - phase: 35-fix-worktree-diff-status-remote-git2-difftarget
    provides: run_git_in_dir dispatcher used for rev-list computation
  - phase: 36-redesign-the-diff-pane-in-the-worktrees-view
    provides: WorktreeManager component consuming WorktreeWithStatus
provides:
  - Schema V6 with base_branch column in worktrees table
  - AheadBehind struct exported from models
  - base_branch persisted on create_worktree IPC
  - ahead/behind counts computed per worktree in list_worktrees_with_status
  - Updated TypeScript bindings with base_branch and AheadBehind types
affects:
  - 37-02 (worktrees card grid frontend uses base_branch for grouping and ahead_behind for indicators)
  - 37-03 (slide-in diff panel may use base_branch context)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "git rev-list --left-right --count HEAD...@{u} parsed into named AheadBehind struct"
    - "base_branch persisted as TEXT nullable column at worktree creation time"
    - "DbWorktreeRow private struct gains base_branch field alongside column index shift"

key-files:
  created: []
  modified:
    - src-tauri/src/db/schema.rs
    - src-tauri/src/models/worktree.rs
    - src-tauri/src/models/mod.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src/types/bindings.ts

key-decisions:
  - "Schema V6: drop-and-recreate pattern (no production data) adds base_branch TEXT nullable after branch_name"
  - "AheadBehind uses named struct (not tuple) for guaranteed specta/TS compatibility"
  - "create_worktree_for_task passes rusqlite::types::Null for base_branch — task worktrees have no user-specified origin branch"
  - "rev-list git error (no upstream) silently yields None via unwrap_or_default — worktrees without remotes just show no indicator"

patterns-established:
  - "AheadBehind: named struct with ahead/behind u32 fields — reusable for future upstream tracking UI"

requirements-completed: [WT37-SCHEMA, WT37-MODEL, WT37-AHEAD-BEHIND, WT37-BASE-BRANCH-PERSIST]

# Metrics
duration: 5min
completed: 2026-04-01
---

# Phase 37 Plan 01: Backend Schema + Model Extension Summary

**SQLite Schema V6 with base_branch column, AheadBehind struct, and per-worktree ahead/behind computation via git rev-list dispatched through existing GitConnection**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-01T20:30:12Z
- **Completed:** 2026-04-01T20:34:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Schema V6: added `base_branch TEXT` nullable column to worktrees table; drop-and-recreate migration applied
- Extended Rust models: `AheadBehind { ahead, behind }` struct + `base_branch` on both `Worktree` and `WorktreeWithStatus`
- `create_worktree` IPC now persists `origin_branch` as `base_branch`; `create_worktree_for_task` stores NULL
- `list_worktrees_with_status` computes ahead/behind per worktree via `git rev-list --left-right --count HEAD...@{u}` in existing parallel tokio::spawn closures
- TypeScript bindings regenerated: `base_branch` appears in both `Worktree` and `WorktreeWithStatus`; `AheadBehind` type exported

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema V6 migration + model extension** - `b432026` (feat)
2. **Task 2: IPC handlers — persist base_branch + compute ahead/behind + regenerate bindings** - `f1f0545` (feat)

## Files Created/Modified
- `src-tauri/src/db/schema.rs` - SCHEMA_VERSION=6, SCHEMA_V6 const, base_branch column, test updated
- `src-tauri/src/models/worktree.rs` - AheadBehind struct, base_branch on Worktree + WorktreeWithStatus
- `src-tauri/src/models/mod.rs` - AheadBehind added to pub use exports
- `src-tauri/src/ipc/worktree_handlers.rs` - DbWorktreeRow + SELECT updated, rev-list spawn, INSERT with base_branch
- `src/types/bindings.ts` - Regenerated with AheadBehind and base_branch fields

## Decisions Made
- AheadBehind uses a named struct (not a tuple) for guaranteed specta/TypeScript compatibility — tuples serialize as arrays which can cause frontend type issues
- `create_worktree_for_task` stores NULL for base_branch — task worktrees branch from HEAD without an explicit user-specified origin
- rev-list failure (e.g. no upstream configured) silently produces `None` via `unwrap_or_default()` — worktrees without remotes simply show no ahead/behind indicator in the UI

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added AheadBehind to models/mod.rs pub use exports**
- **Found during:** Task 2 (IPC handlers update)
- **Issue:** AheadBehind defined in worktree.rs but not re-exported from models/mod.rs; import in worktree_handlers.rs would fail
- **Fix:** Added AheadBehind to the `pub use worktree::` line in models/mod.rs
- **Files modified:** src-tauri/src/models/mod.rs
- **Verification:** cargo check passes with 0 errors
- **Committed in:** b432026 (Task 1 commit, included with schema/model changes)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for compilation. No scope creep.

## Issues Encountered
- Task 1 verification (cargo test) could not pass before Task 2 was partially complete — the struct field additions caused compile errors in worktree_handlers.rs. Proceeded to Task 2 immediately and committed Task 1 + Task 2 cleanly after both were done.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Schema V6 live, TypeScript bindings updated — Plan 37-02 (card grid frontend) can use `base_branch` for grouping worktrees by origin branch and `ahead_behind` for push/pull indicator badges
- All Rust tests pass (5/5), frontend build clean

---
*Phase: 37-redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel*
*Completed: 2026-04-01*

## Self-Check: PASSED

- FOUND: src-tauri/src/db/schema.rs
- FOUND: src-tauri/src/models/worktree.rs
- FOUND: src-tauri/src/ipc/worktree_handlers.rs
- FOUND: src/types/bindings.ts
- FOUND: commit b432026
- FOUND: commit f1f0545
