# Fix: Pre-commit hook fires on squash merge commit during task approval

## Context

When user approves a task review (worktree → merge to main), `squash_merge_to_main()` runs `git commit` in the **project root** without `--no-verify`. Pre-commit hooks fire against the project root's working tree state — which is the squash-merged diff, not the worktree context where development happened. Hook failures produce confusing errors unrelated to the actual worktree changes.

This is a programmatic merge commit. Hooks already ran when the agent committed in the worktree. Re-running them on the squash merge is redundant and incorrect-context.

## Fix

**File:** `src-tauri/src/git/mod.rs` line 541

```rust
// Before:
run_git_in_dir(conn, repo_path, &["commit", "-m", &commit_msg])

// After:
run_git_in_dir(conn, repo_path, &["commit", "--no-verify", "-m", &commit_msg])
```

Single argument addition. No logic changes, no new error paths.

## Why safe

- `--no-verify` skips pre-commit/commit-msg hooks only — does not bypass conflict checks (handled in steps 3-4a)
- Matches how merge bots (GitHub merge queue, bors, mergify) handle programmatic merges
- The other commit path (`commit_worktree` in `worktree_handlers.rs`) is unaffected — that's user-initiated and should keep hooks

## Noted secondary issues (separate scope)

1. **`merge_strategy` dead code** — `let _ = merge_strategy;` at `review_handlers.rs:214` means "Commit only" UI option does nothing (always squash-merges)
2. **Uncommitted worktree changes silently lost** — no auto-commit in worktree before squash merge; only committed branch changes are merged

## Verification

- Build: `cd src-tauri && cargo check`
- Manual: approve a task in project with pre-commit hook → commit should succeed without hook errors
