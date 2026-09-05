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
  | { kind: "new-worktree"; baseBranch: string };

export interface PullRequestEntry {
  pullRequest: ProjectPullRequest;
  /** The worktree on this pull request's head branch, if one exists. */
  worktree: WorktreeWithStatus | null;
  action: PullRequestAction;
}

/**
 * Pair each pull request with the worktree on its head branch and the action that follows.
 *
 * A detached worktree is not a match however its row is labelled: it is not on the branch, so
 * reusing it would put a session somewhere other than the pull request's code.
 *
 * The remote-tracking ref, not the bare branch name, is what a fresh worktree is created from — a
 * local branch of that name either does not exist or is the one the missing worktree would have
 * been on, and `create_worktree` resolves `origin/x` to a local `x` that tracks it.
 */
export function pullRequestEntries(
  pullRequests: ProjectPullRequest[],
  worktrees: WorktreeWithStatus[],
  sessionsByPath: Map<string, ActiveSessionInfo[]>,
  remote: string,
): PullRequestEntry[] {
  return pullRequests.map((pullRequest) => {
    const worktree =
      worktrees.find(
        (candidate) => !candidate.detached_at && candidate.branch_name === pullRequest.head_branch,
      ) ?? null;

    if (!worktree) {
      return {
        pullRequest,
        worktree: null,
        action: { kind: "new-worktree", baseBranch: `${remote}/${pullRequest.head_branch}` },
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
