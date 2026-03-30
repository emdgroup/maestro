---
phase: 31-fix-remote-ssh-worktree-bugs-git-ops-origin-branch-detection-and-worktree-path-filtering
plan: "01"
subsystem: backend-git
tags: [rust, ssh, git, bug-fix, remote-ops]
dependency_graph:
  requires: []
  provides: [correct-ssh-session-lookup, remote-worktree-create-with-branch, remote-current-branch, normalized-remote-branches, list-worktrees-dispatcher]
  affects: [worktree_handlers, execution_handlers, git-mod-dispatcher]
tech_stack:
  added: []
  patterns: [ssh-session-connection_id-lookup, shell-single-quoting, dispatcher-match-arm]
key_files:
  created: []
  modified:
    - src-tauri/src/db/connection.rs
    - src-tauri/src/git/remote.rs
    - src-tauri/src/git/mod.rs
decisions:
  - "Use project.connection_id (not project.id) as SSH session map key — connection_id is the foreign key to ssh_connections table, which is the actual map key used on session insert"
  - "Shell single-quote all path arguments in SSH commands to handle paths with spaces correctly"
  - "parse_worktree_list made pub to allow reuse in remote::list_remote_worktrees without code duplication"
  - "_repo_path parameter kept in list_worktrees() dispatcher for API consistency even though Local arm uses path from GitConnection directly"
metrics:
  duration: "0.032h"
  completed: "2026-03-30"
  tasks_completed: 2
  files_modified: 3
---

# Phase 31 Plan 01: Fix SSH Session Lookup and Remote Git Operations Summary

Fixed four SSH-related git operation bugs: wrong session key lookup using project.id instead of connection_id, missing new_branch parameter in remote worktree creation, hardcoded "main" for remote current branch, and unnormalized remote branch listing.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix get_git_connection SSH key + add remote functions to remote.rs | 4195561 | connection.rs, remote.rs |
| 2 | Update git/mod.rs dispatchers to use new remote functions | d6f6e27 | mod.rs |

## What Was Built

### BUG-1: SSH Session Key Fix (connection.rs)

`get_git_connection` was looking up the SSH session by `project.id` but the sessions HashMap is keyed by `connection_id` (the foreign key to `ssh_connections`). Fixed by extracting `connection_id` with a clear error message when the field is `None`.

### BUG-2: create_remote_worktree new_branch (remote.rs + mod.rs)

`create_remote_worktree` lacked the `new_branch: Option<&str>` parameter. When `Some`, the command becomes `git worktree add '{worktree_name}' -b '{new_branch}' '{branch}'`. The mod.rs dispatcher now forwards `new_branch` to the remote implementation.

### BUG-3: get_remote_current_branch (remote.rs + mod.rs)

Added `get_remote_current_branch` that runs `git rev-parse --abbrev-ref HEAD` via SSH. The mod.rs `get_current_branch` dispatcher now calls this for remote projects instead of returning hardcoded `"main"`.

### BUG-4: list_remote_branches normalization (remote.rs)

Replaced the trivial `trim()` implementation with the same normalization logic used in `list_branches_local`: strips leading `*` and spaces, strips `remotes/origin/` prefix, filters HEAD lines, sorts, and deduplicates.

### prep for Plan 02: list_remote_worktrees + parse_worktree_list public

Added `list_remote_worktrees` that runs `git worktree list --porcelain` via SSH and reuses the existing `parse_worktree_list` parser (now `pub`). Added `list_worktrees()` dispatcher in mod.rs routing Local/Remote.

### Shell Safety: Single-Quoted Paths

All SSH commands in remote.rs now single-quote path arguments (`cd '{}'`) to handle paths with spaces or special characters correctly.

## Deviations from Plan

None — plan executed exactly as written.

The only minor note: Task 2 in the plan specified making `parse_worktree_list` public, but this edit was applied during Task 1 execution since remote.rs calls `crate::git::parse_worktree_list` — it's a prerequisite for remote.rs to compile. Both changes were committed to their respective task commits as planned.

## Known Stubs

None. All functions are fully implemented.

## Self-Check: PASSED

- FOUND: src-tauri/src/db/connection.rs
- FOUND: src-tauri/src/git/remote.rs
- FOUND: src-tauri/src/git/mod.rs
- FOUND: 4195561 (Task 1 commit)
- FOUND: d6f6e27 (Task 2 commit)
