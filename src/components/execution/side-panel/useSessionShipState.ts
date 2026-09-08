import { useMemo } from "react";
import { useAcpSessionMeta, useActiveSessionsQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useBranchPullRequest, useCodeHostingStatus } from "@/services/integration.service";
import type { BranchPullRequestState, PullRequestCheckInfo, PullRequestCi } from "@/types/bindings";
import { branchHasLanded } from "@/lib/branch-landed";
import { deriveCi } from "./shipActions";

/**
 * The pull request on a session's branch, as the Overview card renders it.
 *
 * Everything but `ci` and `failing_checks` comes straight from `fetch_branch_pull_request`; those
 * two are `deriveCi` reading the checks that arrived in the same answer. One question rather than
 * the three at three rates this replaced — detection, state and CI — because on GitHub they are
 * one request, and asking separately cost the card its consistency for nothing.
 */
export interface SessionPullRequest {
  number: number;
  url: string;
  title: string;
  state: BranchPullRequestState;
  /** `null` on a forge that will not enumerate checks, which the card reads as "no checks block". */
  ci: PullRequestCi | null;
  /** Names behind a `Failing` verdict, for the prompt the card seeds. Empty otherwise. */
  failing_checks: string[];
  checks: PullRequestCheckInfo[];
  head_sha: string | null;
  /** RFC 3339, for the "opened 12m ago" line. */
  created_at: string | null;
  base_branch: string | null;
  head_branch: string | null;
  commits: number | null;
  changed_files: number | null;
  additions: number | null;
  deletions: number | null;
  /** `false` is a conflict to resolve; `null` is the forge still computing the merge commit. */
  mergeable: boolean | null;
}

/**
 * Directory paths reach us from three places — the session's `cwd`, git's worktree list, and the
 * database — and on Windows they disagree about slashes and about the case of the drive letter.
 * Comparing them raw silently failed to find the worktree a session was sitting in.
 */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** Why the Open-pull-request action is not available, in the words the card shows. */
export type ShipBlocker =
  | "agent-busy"
  | "uncommitted"
  | "unpushed"
  | "never-pushed"
  | "task-owned"
  | "no-forge"
  | "not-connected"
  | "unsupported-forge"
  | "no-worktree"
  | "pull-request-open";

export interface SessionShipState {
  /** Branch the session's worktree is on, or `null` when it is not in a worktree we know. */
  branch: string | null;
  projectId: number | null;
  /** Anything uncommitted or unpushed — the condition for offering "Commit and push". */
  needsPush: boolean;
  /**
   * At most one action is ever offered; this decides which. `"none"` is a branch whose work has
   * already landed, where every offer would be wrong.
   */
  action: "commit-push" | "open-pull-request" | "none";
  /** `null` when the offered action is available. */
  blocker: ShipBlocker | null;
  pullRequest: SessionPullRequest | null;
  /** Base branch to default the dialog to, and the branches to offer beside it. */
  baseBranch: string | null;
  /**
   * Newest commit's subject, which the dialog offers as the pull request title. `null` when the
   * branch has no commits of its own to describe.
   */
  lastCommitSubject: string | null;
  /** Other live sessions working in the same directory, by name. */
  concurrentSessions: string[];
}

/**
 * Everything the Overview's two shipping affordances need, in one place.
 *
 * The gates come from queries that already exist for other reasons: `WorktreeWithStatus` carries
 * both `changed_files_count` and `ahead_behind`, and the active-session list carries every
 * session's `cwd`. Only the pull request lookup is new, and it is the one that crosses the network
 * — hence the conditions on `enabled` below rather than polling unconditionally.
 *
 * `visible` is the outermost of those conditions and the one that matters most. Every ACP session's
 * panel stays mounted so its state survives navigation, so without it this hook runs for every open
 * session at once and each one asks the forge on its own timer, whether or not anybody is looking
 * at it.
 */
export function useSessionShipState(
  sessionKey: number,
  taskId: number | null,
  isProcessing: boolean,
  projectPath: string | null,
  visible: boolean,
): SessionShipState {
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey);
  const projectId = sessionMeta?.project_id ?? null;

  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath ?? undefined, {
    refetchInterval: visible ? 10_000 : false,
  });
  const { data: hosting } = useCodeHostingStatus(projectId ?? 0);
  const { data: activeSessions } = useActiveSessionsQuery(projectId ?? undefined);

  const worktree = useMemo(
    () => worktrees?.find((entry) => samePath(entry.path, sessionMeta?.cwd)) ?? null,
    [worktrees, sessionMeta?.cwd],
  );

  // A detached worktree has no branch to open anything from, whatever name the row still carries.
  const branch = worktree && !worktree.detached_at ? worktree.branch_name : null;

  // No upstream means there is nothing to measure against, so every commit on the branch counts as
  // unpushed. Distinct from `ahead: 0`, which means it is level with a remote.
  //
  // It does *not* mean the branch was never pushed: a forge deleting the head branch when it merges
  // prunes the remote-tracking ref, and `upstream_gone` is what tells the two apart. That matters
  // because a branch that has been pushed once can have a pull request worth asking about.
  const hasUpstream = worktree?.ahead_behind != null;
  const everPushed = hasUpstream || worktree?.upstream_gone === true;
  const uncommitted = (worktree?.changed_files_count ?? 0) > 0;
  const unpushed = !hasUpstream || (worktree?.ahead_behind?.ahead ?? 0) > 0;
  const needsPush = uncommitted || unpushed;

  // One question, asked by branch: which pull request, what state, and its checks. Deliberately not
  // the project's open list — that answers one *page* of a project which may have thousands open,
  // so a branch missing from it is indistinguishable from a branch that has none, and a session's
  // card would empty itself whenever colleagues were busier than the user. Asking about one branch
  // is exact at any project size and costs the same single request, because only one session panel
  // is ever visible.
  //
  // Disabling on hide keeps the last answer in the cache rather than dropping it, so coming back to
  // the tab paints the state the user left and refreshes behind it.
  const canFind = hosting?.rung === "Ready" && hosting.forge_finds_pull_request_by_branch === true;
  const { data: found } = useBranchPullRequest(
    projectId,
    branch,
    visible && canFind && everPushed && branch != null,
  );

  // The verdict is derived from the checks that arrived in the same answer, which is what keeps the
  // card internally consistent. The block is gated on `ci` and the fix prompt is seeded from
  // `failing_checks`, so when those came from a slower query than the rows they sat above, the
  // header could describe one moment and the ring another — and a pull request whose checks had not
  // queued yet had the whole block hidden regardless of what the faster poll had already fetched.
  const pullRequest: SessionPullRequest | null = useMemo(() => {
    if (!found) return null;
    const { ci, failingChecks } = deriveCi(found.checks);
    return {
      number: found.number,
      url: found.url,
      // Every forge here names a pull request, so the fallback is for a shape we have not seen
      // rather than a case to design for — but a blank line would be worse than the number.
      title: found.title ?? `#${found.number}`,
      state: found.state,
      ci,
      failing_checks: failingChecks,
      checks: found.checks,
      head_sha: found.head_sha,
      created_at: found.created_at,
      base_branch: found.base_branch,
      head_branch: found.head_branch,
      commits: found.commits,
      changed_files: found.changed_files,
      additions: found.additions,
      deletions: found.deletions,
      mergeable: found.mergeable,
    };
  }, [found]);

  const concurrentSessions = useMemo(
    () =>
      (activeSessions ?? [])
        .filter(
          (session) =>
            session.session_key !== sessionKey && samePath(session.cwd, sessionMeta?.cwd),
        )
        .map(
          (session) =>
            session.session_name ?? session.task_name ?? `Session ${session.session_key}`,
        ),
    [activeSessions, sessionKey, sessionMeta?.cwd],
  );

  // A merged pull request sitting on this exact commit means the work is done, and both offers
  // would contradict it — "Commit and push" most loudly, because the merge is also what deleted the
  // upstream that made the branch look unpushed. Once HEAD moves past the merged commit the branch
  // has new work, and commit-push is right again: recreating the deleted upstream is what
  // `commitAndPushPrompt` already asks for.
  const landed = branchHasLanded(pullRequest, worktree);
  const action = landed ? "none" : needsPush ? "commit-push" : "open-pull-request";

  const blocker: ShipBlocker | null = (() => {
    if (landed) return null;
    if (isProcessing) return "agent-busy";
    // A session in the repository directory has no worktree row, so `hasUpstream` is false and it
    // lands here permanently. That is the intended fallback rather than an oversight: the offer is
    // a suggestion the agent can decline as "nothing to commit", whereas the direct action below
    // would be acting on state we cannot read.
    if (action === "commit-push") return null;
    // Past here the branch is pushed and level, so what remains is whether a pull request is this
    // session's to open at all.
    if (taskId != null) return "task-owned";
    if (!worktree) return "no-worktree";
    if (pullRequest && pullRequest.state === "Open") return "pull-request-open";
    if (!hosting || hosting.rung === "NoRemote") return "no-forge";
    if (hosting.rung === "ForgeUnknown") return "no-forge";
    if (!hosting.forge_supports_pull_requests) return "unsupported-forge";
    if (hosting.rung === "NotConnected") return "not-connected";
    return null;
  })();

  return {
    branch,
    projectId,
    needsPush,
    action,
    blocker,
    pullRequest: pullRequest ?? null,
    baseBranch: worktree?.base_branch ?? null,
    // A branch with no commits of its own is still sitting on its base branch's tip, so the subject
    // git read from HEAD describes the base's last commit and not this session's work. Only a
    // literal `0` says that: `commit_count` is `null` when there was no base branch to count
    // against, which is not the same claim and leaves the subject alone.
    lastCommitSubject:
      worktree?.commit_count === 0 ? null : (worktree?.last_commit_subject ?? null),
    concurrentSessions,
  };
}
