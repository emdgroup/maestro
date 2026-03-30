---
phase: 31-fix-remote-ssh-worktree-bugs-git-ops-origin-branch-detection-and-worktree-path-filtering
plan: 02
subsystem: backend/ipc
tags: [ssh, worktrees, git, ipc, bug-fix]
dependency_graph:
  requires: [31-01]
  provides: [SSH-aware worktree IPC layer]
  affects: [src-tauri/src/ipc/worktree_handlers.rs]
tech_stack:
  patterns: [GitConnection dispatcher, get_git_connection helper, SSH-gated filesystem ops]
key_files:
  modified:
    - src-tauri/src/ipc/worktree_handlers.rs
decisions:
  - "Use ? instead of unwrap_or_else for IPC create/delete — fail explicitly on SSH error rather than silently operating on wrong path"
  - "list_worktrees_with_status retains unwrap_or_else fallback — list can degrade gracefully, silently"
  - "Gate create_dir_all on !is_remote — SSH projects create parent dirs automatically via git worktree add"
  - "delete_worktree prefixes _repo_path — path is now derived from project DB lookup, parameter kept for API compatibility"
metrics:
  duration: 0.074h
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 1
---

# Phase 31 Plan 02: SSH-Aware Worktree IPC Handlers Summary

SSH-aware worktree IPC layer using get_git_connection dispatcher for all four handler functions (list, create, delete, cleanup_zombie).

## What Was Built

All worktree IPC handlers in `worktree_handlers.rs` now resolve a `GitConnection` via `crate::db::get_git_connection` instead of hardcoding `GitConnection::Local`. This makes worktree operations work transparently for both local and remote SSH projects.

### Task 1: list_worktrees_with_status SSH-aware (commit ad955f1)

- Added project lookup at handler entry using the project's `from_row` method
- Replaced `crate::git::list_worktrees_local(&repo_path)` with `crate::git::list_worktrees(&git_conn, &repo_path)` (the Plan 01 dispatcher)
- Gated the `tokio::spawn` parallel git status + `git diff --shortstat` block on `!is_remote`
- SSH projects return worktrees with empty `git_status` and `None` diff_stat — the worktree list and DB cross-reference work correctly; per-worktree status can be added later

### Task 2: create_worktree, delete_worktree, cleanup_zombie_worktrees SSH-aware (commit e03f140)

**create_worktree IPC:**
- Added project lookup and `get_git_connection` resolution after determining branch/path names
- Gated `tokio::fs::create_dir_all` on `!is_remote` — SSH projects create the parent directory automatically as part of `git worktree add`
- Removed hardcoded `GitConnection::Local { path: repo_path.clone() }` line

**delete_worktree IPC:**
- Changed DB query from `SELECT path` to `SELECT path, project_id` to retrieve the owning project
- Added project lookup and `get_git_connection` resolution
- Prefixed `repo_path` parameter with `_` (now unused — path derived from project DB lookup)

**cleanup_zombie_worktrees IPC:**
- Added project lookup and `get_git_connection` resolution before the disk-existence check
- Replaced `crate::git::list_worktrees_local(&repo_path)` with `crate::git::list_worktrees(&git_conn, &repo_path)` dispatcher
- Replaced hardcoded `GitConnection::Local { path: repo_path.clone() }` per-candidate with the resolved `git_conn`

**Also fixed:** Removed unused `GitConnection` from the `use crate::models` import (now accessed via fully-qualified path in fallbacks only).

## Verification Results

```
cargo check:  PASSED (0 errors, 0 warnings after cleanup)
pnpm build:   PASSED (✓ built in 3.21s, 0 TypeScript errors)
grep -n "list_worktrees_local" worktree_handlers.rs:  0 matches
grep -n "get_git_connection" worktree_handlers.rs:    4 matches (list, create, delete, cleanup)
```

Remaining `GitConnection::Local` in file: 3 occurrences — 1 fallback in `list_worktrees_with_status` (intentional graceful degradation) + 2 in internal helpers `create_worktree_for_task` / `delete_worktree_for_task` (out of scope for this plan — not IPC commands).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Used `?` instead of `unwrap_or_else` fallback for create/delete/cleanup**
- **Found during:** Task 2
- **Issue:** The plan showed `unwrap_or_else(|_| GitConnection::Local {...})` fallbacks in create/delete handlers. For operations that mutate state (create/delete), silently falling back to local would operate on the wrong path for a remote project — a data integrity issue.
- **Fix:** Used `?` to propagate the error. If SSH session isn't initialized, the operation fails with a clear error message rather than silently operating on the local filesystem.
- **Files modified:** src-tauri/src/ipc/worktree_handlers.rs
- **Commits:** e03f140

## Known Stubs

None — all worktree IPC handlers now use the SSH dispatcher. Per-worktree SSH status (git status + diff --shortstat) for remote projects is not yet implemented (returns empty), but this is documented inline and does not block the plan's stated goal.

## Self-Check: PASSED

- [x] `src-tauri/src/ipc/worktree_handlers.rs` exists and contains `get_git_connection` at lines 31, 345, 463, 547
- [x] commit ad955f1 exists (Task 1)
- [x] commit e03f140 exists (Task 2)
- [x] `cargo check` exits 0
- [x] `pnpm build` exits 0
