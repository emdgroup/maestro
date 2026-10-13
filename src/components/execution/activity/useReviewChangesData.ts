import { useMemo, useEffect, useRef } from "react";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import {
  useWorktreeDiffQuery,
  useWorktreeDiffStatsQuery,
  useWorktreeCommitsQuery,
} from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import { buildDisplayItems, fileCountFrom } from "@/components/execution/diff/useReviewItems";
import { scopeToDiffTarget, type DiffScope } from "@/components/execution/diff/scope";
import type { DiffTarget } from "@/types/bindings";

const UNCOMMITTED_TARGET: DiffTarget = { type: "Head" };

export function useReviewChangesData({
  sessionId,
  isActive,
  scope,
  baseBranch,
  onDiffStats,
}: {
  sessionId: string;
  isActive: boolean;
  scope: DiffScope;
  /** The session worktree's base branch, which anchors "All changes" when there is no start sha. */
  baseBranch: string | null;
  onDiffStats?: (stats: { insertions: number; deletions: number } | null) => void;
}) {
  const { data: sessionMeta, isError: metaError } = useAcpSessionMeta(sessionId ?? null);
  const projectId = sessionMeta?.project_id ?? null;
  const cwd = sessionMeta?.cwd ?? null;
  const startSha = sessionMeta?.session_start_sha ?? null;

  // The start sha comes first so "All changes" means this session's work, as it always has. The
  // base branch only stands in when the session has none, which otherwise left the tab showing
  // uncommitted changes alone — empty the moment the agent committed.
  const scopeAnchors = useMemo(() => ({ startSha, baseBranch }), [startSha, baseBranch]);
  const diffTarget = useMemo(() => scopeToDiffTarget(scope, scopeAnchors), [scope, scopeAnchors]);
  const allChangesTarget = useMemo(
    () => scopeToDiffTarget({ type: "all" }, scopeAnchors),
    [scopeAnchors],
  );

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
    refetch,
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget, {
    refetchInterval: isActive ? 5000 : false,
  });

  // The selector's fixed rows describe scopes other than the one on screen, so their counts come
  // from their own `--stat` queries. Same targets as `useSessionDiffStats`, so they share its fetch.
  const statsPolling = { refetchInterval: isActive ? 10000 : (false as const) };
  const { data: uncommittedStats } = useWorktreeDiffStatsQuery(
    projectId,
    cwd,
    UNCOMMITTED_TARGET,
    statsPolling,
  );
  const { data: allChangesStats } = useWorktreeDiffStatsQuery(
    projectId,
    cwd,
    allChangesTarget,
    statsPolling,
  );
  // `get_worktree_commits` lists `merge-base(anchor, HEAD)..HEAD`, which for a start sha on the
  // branch is the start sha itself: exactly the commits this session made.
  const commitsQuery = useWorktreeCommitsQuery(projectId, cwd, startSha ?? baseBranch);

  // Polling stops while the tab is off screen, so re-entering it would otherwise show
  // the diff as of the last time it was visible until the next interval fires.
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActive.current) void refetch();
    wasActive.current = isActive;
  }, [isActive, refetch]);

  // Read out of the optional chain first: an optional member expression in a
  // dependency array is opaque to the compiler and drops the memoization.
  const diff = diffResult?.diff;
  const untracked = diffResult?.untracked_files;

  const diffFiles = useMemo(() => (diff ? parseDiffString(diff) : []), [diff]);

  const untrackedFiles = useMemo(() => untracked ?? [], [untracked]);

  const allDisplayItems = useMemo(
    () => buildDisplayItems(diffFiles, untrackedFiles),
    [diffFiles, untrackedFiles],
  );

  const loading = diffLoading || (projectId === null && cwd === null && !metaError);
  const totalFileCount = diffFiles.length + untrackedFiles.length;

  const totalStats = useMemo(() => {
    if (diffFiles.length === 0) return null;
    let insertions = 0;
    let deletions = 0;
    for (const f of diffFiles) {
      const s = computeFileStats(f.hunks);
      insertions += s.insertions;
      deletions += s.deletions;
    }
    return { insertions, deletions };
  }, [diffFiles]);

  useEffect(() => {
    onDiffStats?.(totalStats);
  }, [totalStats, onDiffStats]);

  const truncationInfo = useMemo(() => {
    if (!diffResult) return null;
    if (!diffResult.diff_truncated && !diffResult.untracked_truncated) return null;
    return {
      diffTruncated: diffResult.diff_truncated,
      totalDiffBytes: diffResult.total_diff_bytes,
      untrackedTruncated: diffResult.untracked_truncated,
      totalUntracked: diffResult.total_untracked,
    };
  }, [diffResult]);

  return {
    projectId,
    cwd,
    // Handed back because expanding a hunk reads the file's pre-image, which only exists at this
    // target's base revision — the diff string alone does not say what that revision was.
    diffTarget,
    allDisplayItems,
    loading,
    totalFileCount,
    diffError,
    truncationInfo,
    commits: commitsQuery.data ?? [],
    commitsLoading: commitsQuery.isLoading,
    uncommittedFileCount: fileCountFrom(uncommittedStats),
    allChangesFileCount: fileCountFrom(allChangesStats),
  };
}
