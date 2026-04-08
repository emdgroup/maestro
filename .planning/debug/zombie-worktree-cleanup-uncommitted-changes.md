---
status: awaiting_human_verify
trigger: "Worktrees manually created (no task attached) are silently deleted on app restart, even when they contain uncommitted changes. They should never be cleaned up if they have uncommitted changes."
created: 2026-04-01T00:00:00Z
updated: 2026-04-01T00:00:00Z
symptoms_prefilled: true
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — cleanup_zombie_worktrees selects all worktrees where task_id IS NULL (or task Done/Cancelled) and deletes them with no uncommitted-changes guard. A manually-created worktree with uncommitted changes qualifies as a zombie candidate and is deleted.
test: Fix applied — before deleting each candidate, run `git status --porcelain` in the worktree directory. If output is non-empty, skip that worktree.
expecting: Worktrees with uncommitted changes survive cleanup; only truly empty abandoned worktrees are deleted.
next_action: Verify fix compiles correctly with cargo check.

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: A worktree with uncommitted changes should NEVER be classified as a zombie or cleaned up — regardless of whether it has a task attached.
actual: Any worktree manually created (no task attached) is removed automatically and silently on restart, even with uncommitted changes.
errors: No error shown to user — silent deletion.
reproduction: Create a worktree manually (not via a task), make some file edits without committing, restart the app — worktree is gone.
started: Unknown — zombie cleanup feature has existed in the codebase for some time.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-01T00:01:00Z
  checked: src-tauri/src/ipc/worktree_handlers.rs lines 440-500 (cleanup_zombie_worktrees)
  found: SQL query selects candidates where `w.task_id IS NULL OR t.status IN ('Done', 'Cancelled')` AND no running execution log. Then filters by age > 10 minutes. Then checks if on-disk. NO check for uncommitted changes.
  implication: A manually-created worktree older than 10 minutes with no task will always be deleted. No uncommitted-changes guard exists.

- timestamp: 2026-04-01T00:01:30Z
  checked: src-tauri/src/git/mod.rs (run_git_in_dir, git_status_local)
  found: `run_git_in_dir(&conn, abs_path, &["status", "--porcelain"])` already used in list_worktrees_with_status to detect dirty worktrees. Non-empty output = uncommitted changes.
  implication: The same mechanism can be applied inside cleanup_zombie_worktrees before deleting each candidate.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: cleanup_zombie_worktrees selected all taskless worktrees older than 10 minutes and deleted them with no uncommitted-changes guard. A manually-created worktree with live edits matched the zombie SQL query (task_id IS NULL, age > 10 min, on-disk) and was silently deleted.

fix: Added a `git status --porcelain` check per candidate before it is added to the to_delete list. If the output is non-empty (any modified, staged, or untracked file exists), the worktree is skipped with an eprintln log line and never deleted.

verification: cargo check passes. Logic correct: empty porcelain output = clean worktree = safe to delete. Non-empty = live work = skip.

files_changed:
  - src-tauri/src/ipc/worktree_handlers.rs
