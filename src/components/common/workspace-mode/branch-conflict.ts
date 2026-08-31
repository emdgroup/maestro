import type { BranchList, WorktreeWithStatus } from "@/types/bindings";

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
 * The local branch checking out `branch` lands on: `origin/foo` becomes `foo`, because that is
 * the branch `git worktree add --track -b` creates for it.
 *
 * Membership of `branches.remote` is what marks a name as remote-qualified — a slash cannot,
 * since `feature/payments` and `maestro/kind-canyon-49` are ordinary local branches. A name in
 * both lists is a local branch really called `origin/foo`, living at `refs/heads/origin/foo`, and
 * the local one wins. Mirrors `local_branch_for` in `src-tauri/src/git/ops.rs`, which is
 * authoritative; this one only decides what the UI warns about.
 */
export function checkoutTargetBranch(branch: string, branches: BranchList): string {
  if (branches.local.includes(branch)) return branch;
  if (!branches.remote.includes(branch)) return branch;
  const separator = branch.indexOf("/");
  if (separator <= 0) return branch;
  return branch.slice(separator + 1) || branch;
}

const NO_BRANCHES: BranchList = { local: [], remote: [] };

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
 * `branches` lets a remote-qualified `branch` be resolved to the local one it would actually check
 * out — see `checkoutTargetBranch`. Without it, picking `origin/main` would report no conflict and
 * then fail in git, because the worktree holding it is recorded as being on `main`.
 *
 * Advisory only. The branch can be taken between this check and the `git worktree add`, so callers
 * must still handle git's own error.
 */
export function findBranchConflict(
  branch: string,
  worktrees: WorktreeWithStatus[],
  repoPath: string,
  branches: BranchList = NO_BRANCHES,
): BranchConflict | null {
  if (!branch) return null;

  const target = checkoutTargetBranch(branch, branches);
  const holder = worktrees.find((wt) => wt.detached_at == null && wt.branch_name === target);
  if (!holder) return null;

  return normalize(holder.path) === normalize(repoPath)
    ? { kind: "repositoryDirectory", worktree: holder }
    : { kind: "worktree", worktree: holder };
}
