import { useMemo, useEffect } from "react";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import type { DiffFileWithName } from "@/types/review";

export type DisplayItem =
  | { kind: "diff"; file: DiffFileWithName }
  | { kind: "untracked"; path: string };

export function useReviewChangesData({
  sessionKey,
  sessionChangedFiles,
  isActive,
  onDiffStats,
}: {
  sessionKey: number;
  sessionChangedFiles: string[];
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
  } = useWorktreeDiffQuery(projectId, cwd, diffTarget, {
    refetchInterval: isActive ? 10000 : false,
  });

  const changedRelativePaths = useMemo(() => {
    const set = new Set<string>();
    for (const path of sessionChangedFiles) {
      if (cwd && path.startsWith(cwd + "/")) {
        set.add(path.slice(cwd.length + 1));
      } else {
        set.add(path);
      }
    }
    return set;
  }, [sessionChangedFiles, cwd]);

  const diffFiles = useMemo(() => {
    if (!diffResult?.diff) return [];
    const all = parseDiffString(diffResult.diff);
    if (changedRelativePaths.size === 0) return all;
    return all.filter((f) => changedRelativePaths.has(f.fileName));
  }, [diffResult?.diff, changedRelativePaths]);

  const untrackedFiles = useMemo(() => {
    const all = diffResult?.untracked_files ?? [];
    if (changedRelativePaths.size === 0) return all;
    return all.filter((p) => changedRelativePaths.has(p));
  }, [diffResult?.untracked_files, changedRelativePaths]);

  const allDisplayItems = useMemo<DisplayItem[]>(
    () => [
      ...diffFiles.map((file): DisplayItem => ({ kind: "diff", file })),
      ...untrackedFiles.map((path): DisplayItem => ({ kind: "untracked", path })),
    ],
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

  return { projectId, cwd, allDisplayItems, loading, totalFileCount, diffError };
}
