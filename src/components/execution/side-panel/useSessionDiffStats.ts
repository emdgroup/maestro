import { useEffect, useMemo, useRef } from "react";
import { useWorktreeDiffStatsQuery } from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import { fileCountFrom } from "@/components/execution/diff/useReviewItems";
import type { DiffTarget } from "@/types/bindings";

/** How the headline count should be read, matching `useReviewChangesData`'s field of the same name. */
export type SessionDiffScope = "session" | "uncommitted";

const UNCOMMITTED_TARGET: DiffTarget = { type: "Head" };

/**
 * Diff stats for a session's worktree, measured from the session's starting commit.
 *
 * Called from both `SidePanelContent` (to render) and `AgentActivityPanel` (to decide
 * whether to open the Review tab) — both queries are cache-keyed, so the two callers
 * share one fetch.
 *
 * `changedFilesCount` is `null` until the first fetch settles, which lets the tab logic
 * treat a resumed session's pre-existing diff as a baseline rather than a new change.
 */
export function useSessionDiffStats(sessionKey: number, poll: boolean) {
  // Polled, unlike every other caller of this hook: the answer carries whether the session's start
  // commit is still reachable, and a rebase or amend can orphan it mid-session. 30s rather than the
  // 10s below because that is the only field that moves and re-asking costs a `git cat-file` that
  // runs over SSH for a remote project.
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey, {
    refetchInterval: poll ? 30000 : false,
  });

  const startSha = sessionMeta?.session_start_sha ?? null;
  const projectId = sessionMeta?.project_id ?? null;
  const cwd = sessionMeta?.cwd ?? null;

  // Memoized because it is part of a query key: a fresh object literal each render would be a
  // fresh key each render.
  const diffTarget = useMemo<DiffTarget>(
    () => (startSha ? { type: "Commit", sha: startSha } : { type: "Head" }),
    [startSha],
  );

  const {
    data,
    isError,
    refetch: refetchTotal,
  } = useWorktreeDiffStatsQuery(projectId, cwd, diffTarget, {
    refetchInterval: poll ? 10000 : false,
  });

  // The headline is anchored at the session's start commit and so does not move when the agent
  // commits — that is the point of the anchor, but on its own it made shipping look like a no-op.
  // This second, cheap `--stat` says how much of the total is still outstanding. Same pattern and
  // same query key as the Review panel's scope selector (`WorktreeDiffPanel.tsx`), so on that tab
  // it costs nothing.
  const { data: uncommitted, refetch: refetchUncommitted } = useWorktreeDiffStatsQuery(
    projectId,
    cwd,
    UNCOMMITTED_TARGET,
    { refetchInterval: poll ? 10000 : false },
  );

  // Polling pauses whenever the session is off screen, and `refetchOnWindowFocus` is off globally,
  // so returning to the panel would otherwise show git state as of whenever the user left it.
  // Same fix as `useReviewChangesData`.
  const wasPolling = useRef(poll);
  useEffect(() => {
    if (poll && !wasPolling.current) {
      void refetchTotal();
      void refetchUncommitted();
    }
    wasPolling.current = poll;
  }, [poll, refetchTotal, refetchUncommitted]);

  return {
    diffStats: data ? { insertions: data.insertions, deletions: data.deletions } : null,
    // Counted from git, not from the agent's tool-call stream: an agent that edits through
    // a shell reports no file locations, and the card would claim "No changes".
    changedFilesCount: data ? fileCountFrom(data) : null,
    uncommittedFilesCount: uncommitted ? fileCountFrom(uncommitted) : null,
    // Without a usable start commit the diff degrades to uncommitted-only, and saying so is the
    // difference between a small number and a wrong one.
    scope: (startSha ? "session" : "uncommitted") as SessionDiffScope,
    // `git diff` failing is not the same as it reporting nothing — see `diff_stats_in`.
    isError,
  };
}
