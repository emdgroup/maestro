import type { ShipBlocker, SessionPullRequest } from "./useSessionShipState";
import type { PullRequestCheckInfo } from "@/types/bindings";

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
 * The card's verdict on a set of checks, and the names behind a `Failing` one.
 *
 * A mirror of Rust's `summarise_checks` + `ci_summary`, and it has to stay one: the card renders
 * whatever the fast checks poll last returned, and deriving the verdict here is what lets that poll
 * drive the whole block. Reading `ci` off the slower lookup instead left the header, the fix prompt
 * and the ring describing three different moments — and hid the block entirely for a pull request
 * whose checks had not queued yet, since that lookup answers `null` for an empty list.
 *
 * `Running` outranks `Failed` deliberately, matching Rust and *not*
 * {@link import("../worktree-card/pullRequestCi").summariseChecks}, whose opposite ordering is
 * correct for the single indicator it feeds. `Failing` here unlocks "send failing checks to the
 * agent", and spending a fix round on a matrix that has not finished is the mistake this ordering
 * exists to prevent.
 *
 * `null` for an empty list — a forge that will not enumerate, which the card reads as "no checks
 * block" rather than drawing a ring at zero of zero.
 */
export function deriveCi(checks: PullRequestCheckInfo[]): {
  ci: SessionPullRequest["ci"];
  failingChecks: string[];
} {
  if (checks.length === 0) return { ci: null, failingChecks: [] };
  if (checks.some((check) => check.status === "Running")) {
    return { ci: "Pending", failingChecks: [] };
  }
  const failing = checks.filter((check) => check.status === "Failed").map((check) => check.name);
  return failing.length > 0
    ? { ci: "Failing", failingChecks: failing }
    : { ci: "Passing", failingChecks: [] };
}

/**
 * Names the checks. "CI is failing, fix it" spends the agent's first turn discovering what this
 * message already knows.
 */
export function fixChecksPrompt(pullRequest: SessionPullRequest): string {
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
