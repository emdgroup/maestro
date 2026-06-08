# Fix: Task execution hangs when `isolated_worktree` is disabled

## Context

Task execution silently hangs when `isolated_worktree` is unchecked. Root cause: `useExecuteTask` runs a dirty-check on `cwd` for all execution paths. When dirty files are detected (common for main repo), it creates a Promise awaiting user input via `setDirtyState`. But `DirtyWorktreeDialog` is **never rendered by any consumer** — the Promise never resolves, execution hangs forever.

With `isolated_worktree = true`, a fresh worktree is created (always clean) → dirty check passes → works fine.

The dirty check itself is correct and necessary for ALL paths — without it, unrelated uncommitted changes in the main repo would pollute the review diff, confusing the user.

## Fix

Render `DirtyWorktreeDialog` in both consumers so the Promise can resolve. Also revert the `isExistingWorktree` guard added in the previous attempt — dirty check must run for all paths.

### 1. Revert `useExecuteTask.ts` changes

**File:** `src/utils/hooks/useExecuteTask.ts`

- Remove `let isExistingWorktree = false;` declaration
- Remove `isExistingWorktree = true;` assignment in existing-worktree branch
- Remove `if (isExistingWorktree)` guard — restore original `try {` block so dirty check runs unconditionally
- Restore original comment `// Check for dirty worktree`

### 2. Render DirtyWorktreeDialog in TaskCard.tsx

**File:** `src/components/kanban/task-card/TaskCard.tsx`

Already done in previous attempt — keep these changes:
- Import `DirtyWorktreeDialog`
- Expand `useExecuteTask` destructuring to include dirty dialog state
- Wrap return in Fragment, render `<DirtyWorktreeDialog>` after the card div

### 3. Render DirtyWorktreeDialog in TaskReviewPanel.tsx

**File:** `src/components/execution/diff/TaskReviewPanel.tsx`

Already done in previous attempt — keep these changes:
- Import `DirtyWorktreeDialog`
- Expand `useExecuteTask` destructuring
- Render `<DirtyWorktreeDialog>` alongside other modals

## Verification

1. `pnpm build` — type-check passes
2. Non-isolated task + dirty main repo → click Execute → dirty dialog appears → user picks action → execution proceeds
3. Isolated task + existing worktree with changes → re-execute → dirty dialog appears
4. Isolated task + fresh worktree (no dirty files) → executes immediately, no dialog
