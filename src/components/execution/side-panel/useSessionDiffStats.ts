import { useWorktreeDiffStatsQuery } from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import type { DiffTarget } from "@/types/bindings";

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
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey);

  const diffTarget: DiffTarget = sessionMeta?.session_start_sha
    ? { type: "Commit", sha: sessionMeta.session_start_sha }
    : { type: "Head" };

  const { data } = useWorktreeDiffStatsQuery(
    sessionMeta?.project_id ?? null,
    sessionMeta?.cwd ?? null,
    diffTarget,
    { refetchInterval: poll ? 10000 : false },
  );

  return {
    diffStats: data ? { insertions: data.insertions, deletions: data.deletions } : null,
    // Counted from git, not from the agent's tool-call stream: an agent that edits through
    // a shell reports no file locations, and the card would claim "No changes".
    changedFilesCount: data ? data.file_count + data.untracked_count : null,
  };
}
