import { useMemo } from "react";
import { useAcpSessionMeta, useActiveSessionsQuery } from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useCodeHostingStatus, useBranchPullRequest } from "@/services/integration.service";
import type { BranchPullRequestInfo } from "@/types/bindings";

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
  pullRequest: BranchPullRequestInfo | null;
  /** Base branch to default the dialog to, and the branches to offer beside it. */
  baseBranch: string | null;
  /** Other live sessions working in the same directory, by name. */
  concurrentSessions: string[];
}

/**
 * Everything the Overview's two shipping affordances need, in one place.
 *
 * The gates come from queries that already exist for other reasons: `WorktreeWithStatus` carries
 * both `changed_files_count` and `ahead_behind`, and the active-session list carries every
 * session's `cwd`. Only the pull request lookup is new, and it is the one that crosses the network
 * — hence the three conditions on `enabled` below rather than polling unconditionally.
 */
export function useSessionShipState(
  sessionKey: number,
  taskId: number | null,
  isProcessing: boolean,
  projectPath: string | null,
  poll: boolean,
): SessionShipState {
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey);
  const projectId = sessionMeta?.project_id ?? null;

  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath ?? undefined, {
    refetchInterval: poll ? 10_000 : false,
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

  const canLookUp = hosting?.rung === "Ready" && hosting.forge_supports_branch_lookup === true;
  const { data: pullRequest } = useBranchPullRequest(
    projectId,
    branch,
    canLookUp && hasUpstream && branch != null,
  );

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
    concurrentSessions,
  };
}
