---
phase: 25-backend-overhaul
plan: 01
subsystem: backend/models
tags: [schema-migration, rust, models, worktrees]
dependency_graph:
  requires: []
  provides: [schema-v3, WorktreeWithStatus, ExecutionWithTask, worktree-path-constants]
  affects: [25-02, 25-03, 25-04]
tech_stack:
  added: [git2 = "0.20.4" (vendored-libgit2), notify = "8.2.0"]
  patterns: [todo!() stubs for deferred handler rewrites]
key_files:
  created: []
  modified:
    - src-tauri/src/db/schema.rs
    - src-tauri/src/Cargo.toml
    - src-tauri/src/models/worktree.rs
    - src-tauri/src/models/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/ipc/execution_handlers.rs
decisions:
  - "Stub worktree_handlers.rs and spawn/resume execution functions with todo!() to keep cargo check green — Plan 03/04 will rewrite"
  - "WorktreeStatus and PoolStatus fully removed from entire codebase (not just worktree.rs)"
  - "get_pool_status signature changed to return Vec<WorktreeWithStatus> instead of PoolStatus — signals Plan 03 intent"
metrics:
  duration_hours: 0.087
  completed_date: "2026-03-29"
  tasks_completed: 2
  files_modified: 7
---

# Phase 25 Plan 01: Schema v3 + Model Foundation Summary

Schema migration from v2 to v3 (new worktrees table) and worktree model overhaul removing all pool-era types; git2/notify crates added; cargo check passes clean.

## Tasks Completed

| # | Name | Commit | Key Files |
|---|------|--------|-----------|
| 1 | Schema v3 migration + Cargo.toml deps | 2710331 | schema.rs, Cargo.toml |
| 2 | Worktree model overhaul — remove pool types, add view models | 1268d0e | worktree.rs, mod.rs, lib.rs, worktree_handlers.rs, execution_handlers.rs |

## What Was Built

**Schema v3 (schema.rs):**
- `SCHEMA_VERSION` bumped 2 → 3, constant renamed `SCHEMA_V2` → `SCHEMA_V3`
- Worktrees table: replaced `status/leased_at/returned_at` columns with `task_id` (nullable FK to tasks with ON DELETE SET NULL) and `git_status` (nullable TEXT)
- Test extended to assert column presence/absence for both old and new columns

**New Rust crates (Cargo.toml):**
- `git2 = { version = "0.20.4", features = ["vendored-libgit2"] }` — for Plan 03 git operations
- `notify = "8.2.0"` — for Plan 02 file system watching

**Worktree models (worktree.rs — complete rewrite):**
- `Worktree` — simplified DB row matching schema v3 (`task_id: Option<i32>`, `git_status: Option<String>`)
- `WorktreeWithStatus` — view model for Worktrees view with derived fields (`task_name`, `agent_status`, `is_zombie`, `is_orphan`)
- `ExecutionWithTask` — view model for Agents view (execution log enriched with task/worktree data)
- `WORKTREE_DIR`, `WORKTREE_PATH_PREFIX` constants and `worktree_path_for_task(task_id)` helper

**Export plumbing:**
- `models/mod.rs`: replaced `pub use worktree::{Worktree, WorktreeStatus, PoolStatus}` with new exports
- `lib.rs`: removed `WorktreeStatus` from pub use, added `WorktreeWithStatus, ExecutionWithTask, WORKTREE_DIR, WORKTREE_PATH_PREFIX, worktree_path_for_task`

**Stubs for green build:**
- `worktree_handlers.rs`: all 6 handler bodies replaced with `todo!()` — Plan 03 rewrites
- `execution_handlers.rs`: `spawn_agent_execution` and `resume_agent_execution` bodies replaced with `todo!()` — Plan 04 rewrites; unused pool-dependent imports removed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Cleanup] Removed unused imports from execution_handlers.rs**
- **Found during:** Task 2 cargo check
- **Issue:** `spawn_agent_cli_pty`, `ExecutionConfig`, `spawn_agent_execution_dispatcher`, `attach_remote_stream_listener`, `ErrorEvent` all became unused after stubbing the function bodies
- **Fix:** Removed the unused imports, added a comment explaining they'll be re-added in Plan 04
- **Files modified:** `src-tauri/src/ipc/execution_handlers.rs`
- **Commit:** 1268d0e

None — plan executed as specified with the above minor cleanup.

## Verification Results

- `cargo check`: 0 errors, 0 warnings
- `cargo test test_schema_initialization`: PASSED
- `grep -c "WorktreeStatus" src/models/worktree.rs`: 0
- `grep -c "PoolStatus" src/models/worktree.rs`: 0
- `grep -c "WorktreeWithStatus" src/models/worktree.rs`: 1

## Self-Check: PASSED
