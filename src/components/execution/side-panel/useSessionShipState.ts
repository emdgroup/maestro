import { useEffect, useMemo, useState } from "react";
import { useAcpSessionMeta, useActiveSessionsQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import {
  useCodeHostingStatus,
  useBranchPullRequestChecks,
  useProjectPullRequests,
  usePullRequestDetail,
  useRefreshProjectPullRequests,
} from "@/services/integration.service";
import { pullRequestsByBranch } from "@/components/execution/worktree-card/pullRequestCi";
import type {
  BranchPullRequestState,
  ProjectPullRequest,
  PullRequestCheckInfo,
  PullRequestCi,
} from "@/types/bindings";
import { deriveCi } from "./shipActions";

/**
 * The pull request on a session's branch, as the Overview card renders it.
 *
 * Assembled here rather than returned by a command, because no single command answers it any more —
 * and the one that used to cost four forge requests per session to do so. Its identity comes from
 * the project's open list, its state, title and counts from the detail poll, and its verdict from
 * the checks poll: three questions asked at the three different rates they move at.
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
  /** Exactly one of the two actions is ever offered; this decides which. */
  action: "commit-push" | "open-pull-request";
  /** `null` when the offered action is available. */
  blocker: ShipBlocker | null;
  pullRequest: SessionPullRequest | null;
  /** Base branch to default the dialog to, and the branches to offer beside it. */
  baseBranch: string | null;
  /** Newest commit's subject, which the dialog offers as the pull request title. */
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

  // No upstream means the branch has never been pushed, so every commit on it is unpushed and no
  // pull request can exist for it. Distinct from `ahead: 0`, which means it is level with a remote.
  const hasUpstream = worktree?.ahead_behind != null;
  const uncommitted = (worktree?.changed_files_count ?? 0) > 0;
  const unpushed = !hasUpstream || (worktree?.ahead_behind?.ahead ?? 0) > 0;
  const needsPush = uncommitted || unpushed;

  // Detection is the project's open list, not a lookup of our own. "Which pull request is on this
  // branch" is one question for the whole project and one request to answer, and asking it per
  // session cost four — a branch search, its checks, and its summary — multiplied by every session
  // whose panel was open. The same list is what the Worktrees view already polls, so a session and
  // that view now share one answer, and a pull request opened outside Maestro reaches both.
  const canList = hosting?.rung === "Ready" && hosting.forge_supports_pull_request_list === true;
  const detecting = visible && canList && hasUpstream && branch != null;
  const { data: openPullRequests } = useProjectPullRequests(projectId, detecting);
  const byBranch = useMemo(() => pullRequestsByBranch(openPullRequests ?? []), [openPullRequests]);
  const listed = branch ? (byBranch.get(branch) ?? null) : null;

  // The number this session last saw, kept after its entry leaves the list. The list is open-only,
  // so a merge is an entry disappearing — and without remembering it, the card would vanish at the
  // moment it should be saying "Merged", which is the one confirmation the user is waiting for.
  const [linked, setLinked] = useState<ProjectPullRequest | null>(null);
  if (listed && listed.number !== linked?.number) setLinked(listed);
  // A different branch is a different session's question; drop what the last one linked.
  const [linkedBranch, setLinkedBranch] = useState(branch);
  if (linkedBranch !== branch) {
    setLinkedBranch(branch);
    setLinked(listed);
  }

  const entry = listed ?? linked;
  const pullRequestNumber = entry?.number ?? null;

  // Everything about the pull request except its checks, in one request and on its own timer. The
  // list cannot answer any of it: it carries no counts because no forge's list endpoint does, no
  // state because every entry in it is open, and a title it stops updating the moment the pull
  // request leaves it.
  const { data: detail } = usePullRequestDetail(
    projectId,
    pullRequestNumber,
    entry?.head_sha ?? null,
    visible && pullRequestNumber != null,
    true,
  );

  // The list is the faster of the two for a merge — an entry leaves it within a poll — so whichever
  // says "not open" first is believed. `Merged` while the first detail is still in flight because a
  // pull request that has left the open list is far more often merged than closed, and the wrong
  // guess is corrected within one request.
  const state: BranchPullRequestState = listed ? "Open" : (detail?.state ?? "Merged");

  const found: SessionPullRequest | null = useMemo(() => {
    if (!entry) return null;
    return {
      number: entry.number,
      url: entry.url,
      // The list's title is the fallback, not the source: it is frozen for a merged pull request
      // and a poll behind for an open one.
      title: detail?.title ?? entry.title,
      state,
      ci: null,
      failing_checks: [],
      checks: [],
      head_sha: detail?.head_sha ?? entry.head_sha,
      created_at: detail?.created_at ?? entry.created_at,
      base_branch: detail?.base_branch ?? entry.base_branch,
      head_branch: detail?.head_branch ?? entry.head_branch,
      commits: detail?.commits ?? null,
      changed_files: detail?.changed_files ?? null,
      additions: detail?.additions ?? null,
      deletions: detail?.deletions ?? null,
      mergeable: detail?.mergeable ?? null,
    };
  }, [entry, detail, state]);

  // A branch the list does not know may simply have been asked about before the pull request
  // existed — someone opened it on the forge a moment ago, or this session was just selected. The
  // floor inside the refresh is what stops this being a request every time the user switches to a
  // session on a branch that will never have one.
  const refreshPullRequests = useRefreshProjectPullRequests(projectId);
  useEffect(() => {
    if (detecting && !listed && !linked) refreshPullRequests();
  }, [detecting, listed, linked, refreshPullRequests]);

  // CI is its own query and the only one here polled in seconds — it is the half of this card that
  // moves while the user watches. Detection above supplies the number and head sha it needs, so it
  // costs one request and never searches for the pull request again.
  //
  // The verdict is derived from whatever that query last returned, and is the card's only source
  // for it. The card gates its entire checks block on `ci` and seeds its fix prompt from
  // `failing_checks`, so taking those from anywhere slower meant the rows updated underneath a
  // header describing a different moment — and, for a pull request whose checks had not queued yet,
  // meant a `null` verdict hiding the block no matter what the poll had since fetched.
  //
  // Disabling on hide keeps the last answer in the cache rather than dropping it, so coming back to
  // the tab paints the state the user left and refreshes behind it.
  // Not asked at all on a forge that will not name its checks. Gitea, Bitbucket and Azure DevOps
  // answer an empty list by construction, and an empty list is what the poll reads as "CI has not
  // queued yet" — so without this gate they poll at the live rate for the life of the session for
  // an answer that can never arrive.
  const enumeratesChecks = hosting?.forge_enumerates_checks === true;
  const { data: liveChecks } = useBranchPullRequestChecks(
    projectId,
    // Only an open pull request: a merged or closed one's checks cannot change.
    state === "Open" ? pullRequestNumber : null,
    entry?.head_sha ?? null,
    visible && enumeratesChecks,
  );
  const pullRequest = useMemo(() => {
    if (!found || !liveChecks) return found;
    const { ci, failingChecks } = deriveCi(liveChecks);
    return { ...found, checks: liveChecks, ci, failing_checks: failingChecks };
  }, [found, liveChecks]);

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

  const action = needsPush ? "commit-push" : "open-pull-request";

  const blocker: ShipBlocker | null = (() => {
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
    lastCommitSubject: worktree?.last_commit_subject ?? null,
    concurrentSessions,
  };
}
