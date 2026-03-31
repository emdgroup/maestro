---
phase: 35-fix-worktree-diff-status-remote-git2-difftarget
plan: "01"
subsystem: backend
tags: [rust, git, ssh, difftarget, subprocess, worktree]
dependency_graph:
  requires: []
  provides: [DiffTarget enum, run_git_in_dir dispatcher, subprocess-based diff, remote worktree status]
  affects: [src-tauri/src/git/mod.rs, src-tauri/src/ipc/worktree_handlers.rs, src-tauri/src/models/diff.rs, src/types/bindings.ts]
tech_stack:
  added: []
  patterns: [GitConnection dispatcher pattern, tokio::process::Command for local git, SSH execute_command for remote git]
key_files:
  created:
    - src-tauri/src/models/diff.rs
  modified:
    - src-tauri/src/models/mod.rs
    - src-tauri/src/git/mod.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/Cargo.toml
    - src-tauri/Cargo.lock
    - src/types/bindings.ts
    - src-tauri/src/git/remote.rs
    - src-tauri/src/ipc/project_handlers.rs
    - src/components/execution/DiffViewer.tsx
decisions:
  - "run_git_in_dir uses TokioCommand for local and ssh.execute_command for remote — follows existing GitConnection dispatcher pattern"
  - "DiffTarget enum uses serde tag/content for tagged union serialization matching TypeScript discriminated union"
  - "list_worktrees_with_status runs git status + diff --shortstat for both local AND remote (removed is_remote gate)"
  - "Use --format='%(refname:short)' in list_remote_branches for clean branch names without parsing"
  - "Use git symbolic-ref --short HEAD (not rev-parse) so unborn branches on new repos work correctly"
  - "Add -b main to git init commands so default branch is always main (not master)"
metrics:
  duration: "~0.3h"
  completed_date: "2026-03-31"
  tasks_completed: 2
  files_modified: 9
---

# Phase 35 Plan 01: Fix worktree diff/status backend (git2 removal, DiffTarget, remote SSH) Summary

Removed git2 from Cargo.toml, rewrote get_worktree_diff with subprocess-based run_git_in_dir dispatcher, added DiffTarget enum (Head vs Branch mode), fixed list_worktrees_with_status to populate git status/diff_stat for remote SSH worktrees, and regenerated TypeScript bindings.

## What Was Built

### DiffTarget Enum (src-tauri/src/models/diff.rs)
New model with `#[derive(Type)]` and `#[specta(export)]` for TypeScript generation. Two variants:
- `DiffTarget::Head` — runs `git diff HEAD` (uncommitted changes)
- `DiffTarget::Branch(String)` — runs `git diff --unified=6 origin/{name}..HEAD` (full branch diff)

### run_git_in_dir Dispatcher (src-tauri/src/git/mod.rs)
Generic function that dispatches arbitrary git commands to either local subprocess or SSH session:
- Local: `TokioCommand::new("git").args(args).current_dir(abs_path)`
- Remote: `cd '{abs_path}' && git {args joined}` via `ssh.execute_command()`

### Rewritten get_worktree_diff IPC
- New signature: `get_worktree_diff(worktree_id: i32, diff_target: DiffTarget) -> Result<String, String>`
- Uses JOIN query to get worktree path + project path in one DB round-trip
- Resolves GitConnection via `get_project_with_git_conn`
- Dispatches via `run_git_in_dir` — works for both local and SSH projects
- Zero git2, zero spawn_blocking

### Fixed list_worktrees_with_status for Remote
Removed `is_remote` gate that silently skipped status/diff for SSH projects. Now runs parallel tokio::spawn per worktree for both local and remote paths via `run_git_in_dir`.

### TypeScript Bindings (src/types/bindings.ts)
- `DiffTarget = { type: "Head" } | { type: "Branch"; branch: string }` type exported
- `getWorktreeDiff(worktreeId, diffTarget)` — second parameter added

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add DiffTarget model, run_git_in_dir, rewrite get_worktree_diff + remote status | 1d63a32 | models/diff.rs, models/mod.rs, git/mod.rs, ipc/worktree_handlers.rs |
| 2 | Remove git2 from Cargo.toml, regenerate TypeScript bindings | 9166cf0 | Cargo.toml, Cargo.lock, src/types/bindings.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Correctness] Fixed SSH list_remote_branches output format**
- **Found during:** Task 2 (reviewing remote.rs during verification)
- **Issue:** `git branch -a` output contains `*`, spaces, `remotes/origin/` prefix — parse_branch_line was brittle
- **Fix:** Used `--format='%(refname:short)'` for clean output; strip `origin/` prefix with strip_prefix; filter only `HEAD`
- **Files modified:** src-tauri/src/git/remote.rs
- **Commit:** 0e03fa3

**2. [Rule 2 - Missing Correctness] Fixed get_remote_current_branch for unborn branches**
- **Found during:** Task 2 review of remote.rs
- **Issue:** `git rev-parse --abbrev-ref HEAD` fails on repos with no commits; returns "HEAD" literal
- **Fix:** Use `git symbolic-ref --short HEAD` which works on unborn branches; only fallback on empty string
- **Files modified:** src-tauri/src/git/remote.rs
- **Commit:** 0e03fa3

**3. [Rule 2 - Missing Critical] Added -b main to all git init commands**
- **Found during:** Task 2 review of project_handlers.rs
- **Issue:** `git init` without `-b main` creates `master` branch on older git versions, inconsistent with project expectations
- **Fix:** Added `-b main` to all 4 `git init` call sites (local + SSH for both git_init_project and create_new_project)
- **Files modified:** src-tauri/src/ipc/project_handlers.rs
- **Commit:** 0e03fa3

**4. [Rule 1 - Bug] Expanded DiffViewer syntax highlighting language list**
- **Found during:** Related work
- **Issue:** getDiffViewHighlighter called with no explicit language list, resulting in missing syntax highlighting for Rust, Go, Python, etc.
- **Fix:** Passed explicit list of 25+ languages to getDiffViewHighlighter
- **Files modified:** src/components/execution/DiffViewer.tsx
- **Commit:** 7ee2097

## Verification Results

```
cargo check: Finished `dev` profile — 0 errors
grep -r "git2::" src-tauri/src/: 0 results
grep "DiffTarget" src/types/bindings.ts: 2 matches (type + getWorktreeDiff)
grep "run_git_in_dir" src-tauri/src/git/mod.rs: found
grep "run_git_in_dir" src-tauri/src/ipc/worktree_handlers.rs: found in both get_worktree_diff and list_worktrees_with_status
```

## Self-Check: PASSED
