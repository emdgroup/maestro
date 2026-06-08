# Handle Untracked Files on Task Approve

## Context

When an agent creates new files but doesn't commit them, those files are "untracked" in the worktree. The current `approve_task_and_merge` flow only squash-merges committed content — untracked files are **silently lost** when the worktree is deleted after merge.

The `.gitignore` already filters noise (`ls-files --others --exclude-standard`), so remaining untracked files are agent output the user likely wants to keep. Auto-including them (with opt-out) prevents data loss without adding friction to the happy path (agents that commit properly).

## Approach: Auto-commit before merge, with opt-out in ApproveModal

### Backend: Add auto-commit step to `approve_task_and_merge`

**File:** `src-tauri/src/git/review_handlers.rs`

1. Add `include_untracked: bool` parameter to `approve_task_and_merge`
2. Early in the handler (before strategy branching), if `include_untracked` is true:
   - Run `git ls-files --others --exclude-standard` in the task worktree
   - If untracked files exist: `git add -- {files}` + `git commit -m "Include new files from agent session"`
3. This runs regardless of `merge_strategy` — both "merge-delete" and "commit-only" paths benefit
4. Use existing `run_git_in_dir` / `run_git_in_dir_lossy` helpers (already dispatch local/SSH/WSL)
5. If nothing to commit after staging (edge case), skip commit gracefully

### Frontend: Show untracked count in ApproveModal

**File:** `src/components/execution/diff/ReviewConfirmModals.tsx`

1. Add `untrackedCount: number` prop to `ApproveModal`
2. Add state: `includeUntracked` (default **true**)
3. When `untrackedCount > 0`, show amber info section below the strategy radio (or description):
   - "{N} new file(s) not yet committed"
   - Checkbox (checked by default): "Include untracked files"
   - When unchecked, show destructive note: "These files will be permanently lost when worktree is deleted"
4. Checkbox is independent of strategy — applies to both "Commit + Merge + Delete" and "Commit only"
5. Pass `includeUntracked` through `onConfirm`: `onConfirm: (data: { mergeStrategy: string; includeUntracked: boolean }) => void`

**File:** `src/components/execution/diff/TaskReviewPanel.tsx`

1. Pass `untrackedFiles.length` to `ApproveModal`
2. Forward `includeUntracked` from modal confirm to the `approveAndMerge` mutation

**File:** `src/services/task.service.ts`

1. Update `useApproveTaskAndMergeMutation` to accept and pass `includeUntracked` param

### Type generation

Run `pnpm tauri:gen` after Rust signature change — specta auto-generates the updated TS binding.

## Key Details

- `squash_merge_to_main` operates on repo root (main worktree), merging the branch — so files must be committed on the branch in the task worktree BEFORE merge
- `approve_task_and_merge` already has `full_worktree_path` (line 236) and `git_conn` — the auto-commit logic slots in between path construction and the `squash_merge_to_main` call
- The `run_git_in_dir` helper already dispatches correctly across Local/SSH/WSL
- Edge case: if nothing to commit after add (empty commit), skip the commit step rather than failing

## Files to Modify

1. `src-tauri/src/git/review_handlers.rs` — add `include_untracked` param + auto-commit logic
2. `src/components/execution/diff/ReviewConfirmModals.tsx` — ApproveModal untracked banner + checkbox
3. `src/components/execution/diff/TaskReviewPanel.tsx` — wire untrackedCount and includeUntracked
4. `src/services/task.service.ts` — update mutation param type

## Verification

1. `cargo check` in `src-tauri/` — Rust compiles
2. `pnpm tauri:gen` — TS bindings regenerate
3. `pnpm build` — frontend compiles
4. Manual test: create a worktree, add an untracked file, open review panel, approve — file should appear in main after merge
5. Manual test: uncheck "include untracked" — file should NOT appear (confirm warning shown)
