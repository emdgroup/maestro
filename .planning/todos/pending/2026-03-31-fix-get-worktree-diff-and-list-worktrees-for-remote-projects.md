---
created: 2026-03-31T12:23:13.600Z
title: Fix get_worktree_diff and list_worktrees for remote projects
area: git
files:
  - src-tauri/src/ipc/worktree_handlers.rs:225
  - src-tauri/src/ipc/worktree_handlers.rs:103-137
  - src-tauri/src/git/mod.rs
  - src-tauri/src/git/remote.rs
---

## Problem

Two git operations are broken or silently degraded for remote (SSH) projects:

1. **`get_worktree_diff` (worktree_handlers.rs:225)** — completely broken for remote. It constructs a local path from `repo_path + wt_path` and opens it with `git2::Repository::open()` on the local machine. For remote projects, `repo_path` is an SSH path, not a local filesystem path, so this always fails. There is no SSH dispatch whatsoever.

2. **`list_worktrees` per-worktree status/diff-stat (worktree_handlers.rs:103-137)** — silently skipped for remote. The `git status --porcelain` and `git diff --shortstat` per worktree are gated behind `if !is_remote`, so the worktree list shows no git status or diff-stat for remote projects.

The `get_diff_for_review` path is correctly implemented for both (goes through `git::git_diff` dispatcher → `remote::get_remote_diff` over SSH).

## Solution

For `get_worktree_diff`:
- Check whether the project is remote or local (load project settings / connection type from DB, same pattern as review_handlers.rs)
- For remote: run `git diff origin/{branch}..HEAD` via SSH on the remote machine (add a `get_remote_worktree_diff` function in `git/remote.rs` or reuse `get_remote_diff` with appropriate args)
- For local: keep the current git2 in-process approach, or switch to subprocess for consistency

For `list_worktrees` per-worktree status:
- For remote: SSH-execute `git status --porcelain` and `git diff --shortstat` per worktree on the remote machine (similar to `get_worktree_status_local` but via `ssh.execute_command`)
- May want to parallelize with `tokio::join!` or `FuturesUnordered` to avoid serial SSH round-trips
