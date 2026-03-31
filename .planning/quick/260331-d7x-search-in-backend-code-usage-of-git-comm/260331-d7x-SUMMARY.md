# Quick Task 260331-d7x: Git Command Usage in Backend

**Completed:** 2026-03-31

## Result

All git commands invoked by the Rust backend, grouped by file.

---

## `src-tauri/src/git/mod.rs` — Local subprocess via `TokioCommand`

| Function | Git Command |
|----------|------------|
| `list_worktrees_local` | `git worktree list --porcelain` |
| `get_worktree_status_local` | `git status --porcelain` |
| `create_worktree_local` | `git worktree add {worktree_name} {branch}` |
| `create_worktree_local` (new branch) | `git worktree add {worktree_name} -b {new_branch} {branch}` |
| `delete_worktree_local` | `git worktree remove {worktree_name} --force` |
| `git_diff_local` | `git diff --unified=6 {base_branch}...{branch}` |
| `git_status_local` | `git status --porcelain` |
| `list_branches_local` | `git branch -a` |
| `get_current_branch_local` | `git rev-parse --abbrev-ref HEAD` |

---

## `src-tauri/src/git/remote.rs` — SSH string commands

| Function | Git Command |
|----------|------------|
| `create_remote_worktree` | `cd '{path}' && git worktree add '{name}' '{branch}'` |
| `create_remote_worktree` (new branch) | `cd '{path}' && git worktree add '{name}' -b '{new_branch}' '{branch}'` |
| `delete_remote_worktree` | `cd '{path}' && git worktree remove '{name}' --force` |
| `delete_remote_worktree` | `git -C '{path}' branch -D '{name}'` |
| `delete_remote_worktree` | `git -C '{path}' remote prune origin` |
| `get_remote_diff` | `cd '{path}' && git diff --unified=6 {base}...{branch}` |
| `get_remote_status` | `cd '{path}' && git status --porcelain` |
| `list_remote_branches` | `cd '{path}' && git branch -a` |
| `get_remote_current_branch` | `cd '{path}' && git rev-parse --abbrev-ref HEAD` |
| `list_remote_worktrees` | `cd '{path}' && git worktree list --porcelain` |

---

## `src-tauri/src/ipc/project_handlers.rs` — Ad-hoc calls outside git module

| Context | Git Command | Transport |
|---------|------------|-----------|
| `initialize_git_repo` (SSH path) | `git init {path}` | SSH |
| `initialize_git_repo` (local) | `git init {path}` | local subprocess |
| `clone_project` (SSH) | `git clone {url} {target_path}` | SSH |
| `clone_project` (local) | `git clone {url} {target_path}` | local subprocess |
| `create_project` flow (local) | `git init {full_path}` | local subprocess |

---

## `src-tauri/src/ipc/worktree_handlers.rs`

| Context | Git Command | Transport |
|---------|------------|-----------|
| Worktree status enrichment | `git diff --shortstat` | local subprocess |

---

## `src-tauri/src/ipc/review_handlers.rs`

| Context | Git Command | Transport |
|---------|------------|-----------|
| Branch cleanup after review | `git branch -D {branch_name}` | local subprocess |

---

## Summary by Command

| Git Subcommand | Usages |
|----------------|--------|
| `worktree list` | 2 (local + remote) |
| `worktree add` | 2 (local + remote, each with/without `-b`) |
| `worktree remove` | 2 (local + remote) |
| `status --porcelain` | 3 (local×2 + remote×1) |
| `diff --unified=6` | 2 (local + remote) |
| `diff --shortstat` | 1 (local) |
| `branch -a` | 2 (local + remote) |
| `branch -D` | 2 (remote delete + review cleanup) |
| `rev-parse --abbrev-ref HEAD` | 2 (local + remote) |
| `remote prune origin` | 1 (remote only) |
| `init` | 3 (SSH + local×2) |
| `clone` | 2 (SSH + local) |
