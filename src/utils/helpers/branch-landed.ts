import type { BranchPullRequestState, WorktreeWithStatus } from "@/types/bindings";

/**
 * Whether this branch's work has landed and there is nothing left to ship.
 *
 * A merged pull request alone is not enough: the branch can carry commits made after the merge, and
 * then the next thing to do is push them. So the rule is the merge *at this exact commit* — the
 * pull request's head sha is HEAD's, and nothing is uncommitted beside it.
 *
 * Only the forge can answer this. Local ancestry cannot: a squash merge leaves `<base>..HEAD`
 * counting the branch's commits as if nothing had happened, and a forge deleting the head branch on
 * merge prunes the remote-tracking ref, so `ahead_behind` goes to `null` and reads as never pushed.
 *
 * Structurally typed rather than taking the two named types, because the two callers hold different
 * shapes of the same answer — the grid the raw `BranchPullRequestInfo`, the session panel the mapped
 * `SessionPullRequest`.
 */
export function branchHasLanded(
  pullRequest: { state: BranchPullRequestState; head_sha: string | null } | null | undefined,
  worktree: Pick<WorktreeWithStatus, "head_sha" | "changed_files_count"> | null | undefined,
): boolean {
  if (!pullRequest || !worktree) return false;
  if (pullRequest.state !== "Merged") return false;
  // A forge that does not report a head sha cannot establish the equality, and assuming it would
  // hide the action on any branch that had moved on.
  if (!pullRequest.head_sha || !worktree.head_sha) return false;
  if (worktree.changed_files_count > 0) return false;
  return pullRequest.head_sha === worktree.head_sha;
}
