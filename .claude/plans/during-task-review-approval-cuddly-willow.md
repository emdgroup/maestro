# Fix: Task Review Approval Commit Failure

## Context

When approving a task whose agent modified tracked files without committing, the merge fails with "no changes added to commit." Three bugs combine:

1. `review_handlers.rs` approval only stages **untracked** files (`git ls-files --others`) — modified tracked files ignored
2. Task branch has no new commits → `squash_merge_to_base` finds nothing to merge
3. `squash_merge_to_base` uses `git status --porcelain` to detect "nothing to merge" — but pre-existing dirty files on repo root make status non-empty, bypassing the guard → `git commit` runs with nothing staged → fails

Additional bugs found:
- **Counter display**: `TaskReviewPanel.tsx:451` passes `untrackedFiles.length` as `uncommittedFileCount` — misses modified tracked files
- **Commit log**: `worktree_handlers.rs:745` uses `origin/{base_branch}..HEAD` — shows pre-existing commits when local branch is ahead of origin

---

## Fix 1 (Primary): Stage + commit modified tracked files before merge

**File:** `src-tauri/src/git/review_handlers.rs`  
**Location:** Insert before line 346 (`if include_untracked`), unconditional

```rust
// Always commit modified tracked files — agents may modify without committing
crate::git::run_git_in_dir(&git_conn, &full_worktree_path, &["add", "-u"]).await
    .map_err(|e| format!("Failed to stage modified files: {}", e))?;

let staged_output = crate::git::run_git_in_dir(
    &git_conn, &full_worktree_path,
    &["diff", "--cached", "--name-only"],
).await.unwrap_or_default();

if !staged_output.trim().is_empty() {
    crate::git::run_git_in_dir(
        &git_conn, &full_worktree_path,
        &["commit", "--no-verify", "-m", &commit_message],
    ).await.map_err(|e| format!("Failed to commit modified files: {}", e))?;
}
```

`git add -u` stages tracked modifications + deletions. Untracked files stay gated by `include_untracked` flag below.

## Fix 2: Squash merge "nothing to merge" guard

**File:** `src-tauri/src/git/mod.rs` line 603

Replace `git status --porcelain` emptiness check with staged-only check:

```rust
// Before (broken — pre-existing dirty files bypass this):
if status_stdout.trim().is_empty() {
    return Err(format!("Nothing to merge: ..."));
}

// After — check if squash actually staged anything:
let staged_output = run_git_in_dir(conn, repo_path, &["diff", "--cached", "--name-only"])
    .await
    .map_err(|e| format!("git diff --cached failed: {}", e))?;

if staged_output.trim().is_empty() {
    return Err(format!(
        "Nothing to merge: no changes between {} and {}",
        branch_name, target_branch
    ));
}
```

Keep the conflict check using `status --porcelain` (conflicts show as UU/AA/DD in status). Only change the "nothing to merge" guard.

## Fix 3: Uncommitted files counter

**File:** `src/components/execution/diff/TaskReviewPanel.tsx` line 451

Need uncommitted count that includes modified tracked files. Two options:

**Option A** (simple): Compute from existing `diffQuery` when scope is "uncommitted" (DiffTarget::Head returns modified tracked files in `diff` field). But `diffFiles` changes with scope.

**Option B** (correct): Add dedicated uncommitted count. The diff query with `DiffTarget::Head` already returns both `diff` (tracked mods) and `untracked_files`. Parse the Head diff file count separately from the scope-dependent display.

Go with: compute `uncommittedFileCount` from a stable source — fire a separate query with `DiffTarget::Head` or derive from the already-available `dirtyStatus` (if `check_worktree_dirty` is queried). Check if `useWorktreeDirtyQuery` exists; if so, use `modified_count + untracked_count`.

## Fix 4: Commit log origin/ prefix

**File:** `src-tauri/src/git/worktree_handlers.rs` line 745

```rust
// Before:
let range = format!("origin/{}..HEAD", base_branch);

// After — use merge-base for correct fork point:
let merge_base = crate::git::run_git_in_dir(
    &git_conn, &worktree_path, &["merge-base", &base_branch, "HEAD"],
).await.unwrap_or_default();

let range = if merge_base.trim().is_empty() {
    format!("{}..HEAD", base_branch)
} else {
    format!("{}..HEAD", merge_base.trim())
};
```

Shows only commits made on task branch, not pre-existing commits on local main.

---

## Files to Modify

1. `src-tauri/src/git/review_handlers.rs` — Fix 1 (stage modified tracked files)
2. `src-tauri/src/git/mod.rs` — Fix 2 (squash merge guard)
3. `src/components/execution/diff/TaskReviewPanel.tsx` — Fix 3 (counter)
4. `src-tauri/src/git/worktree_handlers.rs` — Fix 4 (commit log base)

## Verification

1. `cargo check` — compiles
2. `cargo test` — passes
3. `pnpm build` — frontend compiles
4. Manual: create task from main (when main ahead of origin), agent modifies tracked file without committing, verify:
   - Counter shows "Uncommitted · 1 files"
   - Commit log shows only agent's commit (not pre-existing)
   - Approve → succeeds
