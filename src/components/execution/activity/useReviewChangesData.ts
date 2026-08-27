import { useMemo, useEffect, useRef } from "react";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import { buildDisplayItems } from "@/components/execution/diff/useReviewItems";

export function useReviewChangesData({
  sessionKey,
  isActive,
  onDiffStats,
}: {
  sessionKey: number;
  isActive: boolean;
  onDiffStats?: (stats: { insertions: number; deletions: number } | null) => void;
}) {
  const { data: sessionMeta, isError: metaError } = useAcpSessionMeta(sessionKey ?? null);
  const projectId = sessionMeta?.project_id ?? null;
  const cwd = sessionMeta?.cwd ?? null;
  const startSha = sessionMeta?.session_start_sha ?? null;

  const diffTarget = useMemo(
    () => (startSha ? ({ type: "Commit", sha: startSha } as const) : ({ type: "Head" } as const)),
    [startSha],
  );

  const {
    data: diffResult,
    isLoading: diffLoading,
    error: diffError,
    refetch,
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget, {
    refetchInterval: isActive ? 5000 : false,
  });

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
    // The diff is anchored at the session's start commit; without one it degrades to
    // uncommitted-only, which silently hides the agent's commits unless the UI says so.
    scope: startSha ? ("session" as const) : ("uncommitted" as const),
  };
}
