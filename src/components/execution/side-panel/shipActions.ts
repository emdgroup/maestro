import type { ShipBlocker } from "./useSessionShipState";
import type { BranchPullRequestInfo } from "@/types/bindings";

/**
 * Why an action is unavailable, in the four or five words the card has room for.
 *
 * Every blocker gets a phrase. A disabled control with no reason beside it is the thing this card
 * cannot afford: the user cannot see the git state it is reading, so "greyed out" alone tells them
 * nothing about what to do next.
 */
export const BLOCKER_LABELS: Record<ShipBlocker, string> = {
  "agent-busy": "agent is busy",
  uncommitted: "uncommitted changes",
  unpushed: "unpushed commits",
  "never-pushed": "branch not pushed",
  "task-owned": "approve on the board",
  "no-forge": "no forge",
  "not-connected": "not connected",
  "unsupported-forge": "forge unsupported",
  "no-worktree": "no worktree",
  "pull-request-open": "already open",
};

/**
 * The push half names the remote and branch rather than saying "push it".
 *
 * An agent left to improvise runs a bare `git push`, which on a branch with no upstream fails with
 * git's own set-upstream advice and costs a turn. Spelling it out also keeps the agent from
 * pushing somewhere the user did not mean.
 */
export function commitAndPushPrompt(branch: string | null): string {
  const target = branch ? `\`${branch}\`` : "the current branch";
  return (
    `Commit everything in this worktree with a message describing what changed, then push ${target} ` +
    `to its remote with \`git push --set-upstream origin ${branch ?? "HEAD"}\`.`
  );
}

/**
 * Names the checks. "CI is failing, fix it" spends the agent's first turn discovering what this
 * message already knows.
 */
export function fixChecksPrompt(pullRequest: BranchPullRequestInfo): string {
  const checks = pullRequest.failing_checks;
  const named =
    checks.length > 0
      ? `The failing checks are: ${checks.join(", ")}.`
      : "CI is failing but the forge did not name the checks.";
  return (
    `CI is failing on pull request #${pullRequest.number} (${pullRequest.url}). ${named} ` +
    `Investigate why they failed, fix the cause, then commit and push to this branch.`
  );
}
