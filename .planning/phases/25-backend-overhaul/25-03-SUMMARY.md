---
phase: 25-backend-overhaul
plan: "03"
subsystem: backend
tags: [rust, worktrees, git2, ipc, tauri]
dependency_graph:
  requires: [25-01, 25-02]
  provides: [worktree-ipc-commands]
  affects: [src-tauri/src/ipc/worktree_handlers.rs, src-tauri/src/lib.rs]
tech_stack:
  added: []
  patterns:
    - git2::Repository inside tokio::task::spawn_blocking for sync git operations
    - parallel tokio::spawn for concurrent git status across multiple worktrees
    - DB lock acquired after async git work to avoid holding mutex across await points
    - orphan/zombie detection by cross-referencing disk state vs DB state
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/lib.rs
    - src-tauri/Cargo.lock
decisions:
  - Implemented all 4 IPC commands and 2 internal helpers in a single file rewrite
  - Auto-delete stale DB rows silently in list_worktrees_with_status (no separate cleanup needed)
  - get_worktree_diff falls back to workdir diff when no origin/{branch} upstream exists
  - create_worktree and delete_worktree use GitConnection::Local for now; remote support handled by existing git dispatcher
metrics:
  duration: 0.035h
  completed_date: "2026-03-29"
  tasks_completed: 2
  files_modified: 3
---

# Phase 25 Plan 03: Worktree IPC Overhaul Summary

Rewrote worktree_handlers.rs with 4 new IPC commands backed by real git operations and new model shapes from Plans 01 and 02, replacing all pool-based stubs.

## Tasks Completed

| # | Task | Commit | Key Changes |
|---|------|--------|-------------|
| 1 | list_worktrees_with_status + get_worktree_diff | 5cffc5d | list with parallel git status, DB enrichment, orphan/zombie detection; diff with git2 in spawn_blocking |
| 2 | create_worktree + delete_worktree + internal helpers | 5cffc5d | IPC commands + create_worktree_for_task + delete_worktree_for_task for Plan 04 |

## What Was Built

### list_worktrees_with_status
- Gets on-disk worktrees via `crate::git::list_worktrees_local`
- Filters main worktree (repo root)
- Queries DB with LEFT JOIN on tasks and execution_logs for enrichment
- Runs parallel `tokio::spawn` tasks for concurrent `git status --porcelain` per worktree
- Cross-references disk vs DB: orphan = on-disk but no DB row; zombie = DB row with no task_id but path matches WORKTREE_PATH_PREFIX
- Auto-deletes DB rows whose worktrees no longer exist on disk
- Returns sorted by created_at DESC

### get_worktree_diff
- Looks up worktree path and branch_name from DB
- Looks up project repo_path from DB
- Uses `git2::Repository::open` inside `tokio::task::spawn_blocking`
- Tries `refs/remotes/origin/{branch}` first for upstream diff
- Falls back to `diff_tree_to_workdir_with_index` if no upstream exists
- Returns unified patch string

### create_worktree
- Accepts `worktree_path` (manual) OR `task_id` (auto-generate path via `worktree_path_for_task`)
- Creates `.maestro/worktrees/` parent directory
- Calls `crate::git::create_worktree` (local git worktree add)
- Inserts DB row after async git work completes

### delete_worktree
- Queries DB for path, calls `crate::git::delete_worktree` (best effort, ignores errors)
- Deletes DB row unconditionally

### Internal Helpers
- `create_worktree_for_task`: used by execution_handlers.rs (Plan 04) to create a worktree on agent spawn
- `delete_worktree_for_task`: used by execution_handlers.rs (Plan 04) to clean up after task completion

### lib.rs Registration
- Replaced 6 old pool commands (lease_worktree, return_worktree, get_pool_status, cleanup_worktree, recover_dirty_worktrees, initialize_worktree_pool) with 4 new commands

## Verification Results

- `cargo check`: PASSED (clean build, 0 errors)
- 4 `#[tauri::command]` annotations: CONFIRMED
- 2 internal helpers: CONFIRMED
- No pool concept references in worktree_handlers.rs: CONFIRMED

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

**Minor implementation notes:**
- Fixed a borrow lifetime error (rusqlite stmt borrow) automatically during Task 1 implementation by collecting results into a Vec before the DB lock scope closes. This is a standard Rust rusqlite pattern, not a plan deviation.

## Known Stubs

None — all 4 IPC commands are fully implemented with real logic. The `create_worktree_for_task` and `delete_worktree_for_task` helpers are ready for Plan 04 to wire into execution_handlers.rs.

## Self-Check: PASSED
