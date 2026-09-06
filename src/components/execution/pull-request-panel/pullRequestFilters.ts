import type { ActiveSessionInfo, ProjectPullRequest, WorktreeWithStatus } from "@/types/bindings";

/** Which pull requests the panel is showing, by whether a worktree exists for them. */
export type LinkFilter = "All" | "WithWorktree" | "Others";

export const LINK_FILTERS: Array<{ value: LinkFilter; label: string }> = [
  { value: "All", label: "All" },
  { value: "WithWorktree", label: "With worktree" },
  { value: "Others", label: "Others" },
];

/**
 * What the panel can do with one pull request, decided by what already exists for it.
 *
 * Three outcomes rather than one button that figures it out later, because the three are genuinely
 * different actions — one navigates, two open a dialog seeded differently — and deciding here is
 * what lets the row render the right label instead of promising "Start session" and then jumping
 * somewhere else.
 */
export type PullRequestAction =
  | { kind: "open-session"; sessionKey: number; sessionLabel: string }
  | { kind: "reuse-worktree"; worktree: WorktreeWithStatus }
  | {
      kind: "new-worktree";
      /** Recorded on the worktree row, and what its card counts commits against. */
      baseBranch: string;
      /**
       * Set for a pull request from a fork, whose head is fetched from the forge's own ref rather
       * than from `baseBranch` — see `create_pull_request_worktree` in `src-tauri/src/git/ops.rs`.
       * Null for one opened on this repository, which is checked out from the remote branch.
       */
      pullRequestNumber: number | null;
    }
  | { kind: "unsupported"; reason: string };

/**
 * The local branch a pull request from a fork is checked out onto.
 *
 * Mirrors `pull_request_branch` in `src-tauri/src/git/ops.rs`, and the two must agree: this is what
 * decides whether a pull request already has a worktree, so a disagreement would offer to create a
 * second one every time.
 *
 * Keyed on the number because the head branch name is not unique — two forks can both open a
 * `patch-1`, and either would collide with a local branch of that name.
 */
export function pullRequestBranch(number: number): string {
  return `pr-${number}`;
}

export interface PullRequestEntry {
  pullRequest: ProjectPullRequest;
  /** The worktree on this pull request's head branch, if one exists. */
  worktree: WorktreeWithStatus | null;
  action: PullRequestAction;
}

/**
 * Pair each pull request with the worktree holding it and the action that follows.
 *
 * A detached worktree is not a match however its row is labelled: it is not on the branch, so
 * reusing it would put a session somewhere other than the pull request's code.
 *
 * **Which branch that is depends on where the pull request came from.** One opened on this
 * repository lives on its own head branch, and a fresh worktree is created from the remote-tracking
 * ref rather than the bare name — a local branch of that name either does not exist or is the one
 * the missing worktree would have been on, and `create_worktree` resolves `origin/x` to a local `x`
 * that tracks it.
 *
 * One opened from a *fork* has no such branch here at all: it lives in a repository this project
 * has no remote for. `${remote}/${head_branch}` is then either nothing — and the checkout fails —
 * or, worse, an unrelated branch of this repository that happens to share the name, which is a
 * silent checkout of the wrong code. `patch-1` and `fix-typo` are not rare. So a fork's pull
 * request is checked out through the ref the forge publishes its head under, onto
 * `pullRequestBranch(number)`, and matched on that name here.
 *
 * `canCheckOutForks` is the forge's answer to whether it publishes such a ref at all. Azure DevOps
 * does not, so its fork rows say so rather than offering an action that cannot work.
 */
export function pullRequestEntries(
  pullRequests: ProjectPullRequest[],
  worktrees: WorktreeWithStatus[],
  sessionsByPath: Map<string, ActiveSessionInfo[]>,
  remote: string,
  canCheckOutForks: boolean,
): PullRequestEntry[] {
  return pullRequests.map((pullRequest) => {
    const localBranch = pullRequest.from_fork
      ? pullRequestBranch(pullRequest.number)
      : pullRequest.head_branch;
    const worktree =
      worktrees.find(
        (candidate) => !candidate.detached_at && candidate.branch_name === localBranch,
      ) ?? null;

    if (!worktree) {
      if (pullRequest.from_fork && !canCheckOutForks) {
        return {
          pullRequest,
          worktree: null,
          action: {
            kind: "unsupported",
            reason:
              "This forge publishes no ref for a fork's head branch, so Maestro cannot check this pull request out. Open it on the forge instead.",
          },
        };
      }
      return {
        pullRequest,
        worktree: null,
        action: {
          kind: "new-worktree",
          // A fork's worktree is created from the forge's ref, so what goes here is only what the
          // row records and counts commits against: the branch the pull request merges into.
          baseBranch: pullRequest.from_fork
            ? (pullRequest.base_branch ?? "")
            : `${remote}/${pullRequest.head_branch}`,
          pullRequestNumber: pullRequest.from_fork ? pullRequest.number : null,
        },
      };
    }

    // An agent already working here is the thing to return to. A terminal is not: it is a shell the
    // user opened, not a conversation to resume, and jumping to one from here would be a surprise.
    const session = (sessionsByPath.get(worktree.path) ?? []).find(
      (candidate) => candidate.execution_mode === "acp",
    );
    if (session) {
      return {
        pullRequest,
        worktree,
        action: {
          kind: "open-session",
          sessionKey: session.session_key,
          sessionLabel:
            session.session_name ?? session.task_name ?? `Session ${session.session_key}`,
        },
      };
    }

    return { pullRequest, worktree, action: { kind: "reuse-worktree", worktree } };
  });
}

/**
 * Whether each row has a worktree, applied to the page on screen.
 *
 * The only filter left here, and the only one that can be. Search went to the forge, because
 * matching thirty rows out of a project's eleven thousand finds almost nothing and reads as an empty
 * repository. A CI filter has the same problem and no server-side answer on any of the six forges,
 * so it went entirely.
 *
 * This one stays because it needs nothing from the forge at all: it is a join between the user's own
 * worktrees and each row's head branch, so it means exactly the same thing on every provider — and
 * "which of these do I not have a worktree for" is the question the panel exists to answer.
 */
export function filterPullRequests(
  entries: PullRequestEntry[],
  link: LinkFilter,
): PullRequestEntry[] {
  return entries.filter((entry) => {
    if (link === "WithWorktree" && !entry.worktree) return false;
    if (link === "Others" && entry.worktree) return false;
    return true;
  });
}
