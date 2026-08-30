import type { WorktreeWithStatus } from "@/types/bindings";

/**
 * Who is holding a branch that something wants to check out.
 *
 * `repositoryDirectory` is separated from `worktree` because the recovery differs: the repository
 * root cannot be reused as a workspace — `WorkspaceSelector` filters it out of that list — so the
 * offer there is `RepositoryDirectory` mode rather than `ReuseWorkspace`.
 */
export type BranchConflict =
  | { kind: "worktree"; worktree: WorktreeWithStatus }
  | { kind: "repositoryDirectory"; worktree: WorktreeWithStatus };

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The worktree already sitting on `branch`, if any — the thing that makes
 * `git worktree add <path> <branch>` fail with "already checked out".
 *
 * `detached_at` is the guard that makes this correct. `list_worktrees_with_status` reads
 * `branch_name` from git, but falls back to the name recorded at creation when the worktree is on a
 * detached HEAD — and sets `detached_at` in exactly that case. Matching on the name alone would
 * therefore report a conflict against a worktree that is on no branch at all and blocks nothing.
 *
 * The repository root is included on purpose: git refuses the branch its main worktree is on for
 * the same reason it refuses any other, and the list already contains that entry.
 *
 * Advisory only. The branch can be taken between this check and the `git worktree add`, so callers
 * must still handle git's own error.
 */
export function findBranchConflict(
  branch: string,
  worktrees: WorktreeWithStatus[],
  repoPath: string,
): BranchConflict | null {
  if (!branch) return null;

  const holder = worktrees.find((wt) => wt.detached_at == null && wt.branch_name === branch);
  if (!holder) return null;

  return normalize(holder.path) === normalize(repoPath)
    ? { kind: "repositoryDirectory", worktree: holder }
    : { kind: "worktree", worktree: holder };
}
