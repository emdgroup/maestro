import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import { taskQueryKeys } from "@/services/task.service";
import type { DiffTarget } from "@/types/bindings";

export const worktreeQueryKeys = {
  base: ["worktrees"] as const,
  list: (projectId: number) => [...worktreeQueryKeys.base, "list", projectId] as const,
  diff: (worktreePath: string, diffTarget: DiffTarget) =>
    [...worktreeQueryKeys.base, "diff", worktreePath, diffTarget] as const,
  prunableBranches: (projectId: number) =>
    [...worktreeQueryKeys.base, "prunable-branches", projectId] as const,
};

/**
 * Event-driven worktree list. Refreshes on "worktrees-changed" Tauri event.
 */
export function useWorktreesQuery(projectId: number | undefined, repoPath: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("worktrees-changed", () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: worktreeQueryKeys.list(projectId ?? 0),
    queryFn: () => api.listWorktreesWithStatus(projectId!, repoPath!),
    enabled: projectId != null && repoPath != null,
  });
}

export function usePrefetchWorktrees() {
  const queryClient = useQueryClient();
  return useCallback(
    (projectId: number, repoPath: string) => {
      void queryClient.prefetchQuery({
        queryKey: worktreeQueryKeys.list(projectId),
        queryFn: () => api.listWorktreesWithStatus(projectId, repoPath),
      });
    },
    [queryClient],
  );
}

export function useUntrackedFileContentQuery(
  projectId: number | null,
  worktreePath: string | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: [...worktreeQueryKeys.base, "untracked-content", worktreePath, filePath] as const,
    queryFn: () => api.getUntrackedFileContent(projectId!, worktreePath!, filePath!),
    enabled: projectId != null && worktreePath != null && filePath != null,
    staleTime: 30000,
  });
}

/**
 * Query hook for fetching worktree diff (unified diff string).
 * Uses project_id + absolute worktree path — no DB lookup needed.
 */
export function useWorktreeDiffQuery(
  projectId: number | null,
  worktreePath: string | null,
  diffTarget: DiffTarget,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: worktreeQueryKeys.diff(worktreePath ?? "", diffTarget),
    queryFn: () => api.getWorktreeDiff(projectId!, worktreePath!, diffTarget),
    enabled: projectId != null && worktreePath != null,
    refetchInterval: options !== undefined ? options.refetchInterval : 10000,
    staleTime: 4000,
  });
}

/**
 * Lightweight query hook for diff stats only (file count, insertions, deletions, untracked count).
 * Uses `git diff --stat` — payload is tiny regardless of diff size. Use this for stats display
 * in session headers; use useWorktreeDiffQuery only when the actual diff content is needed.
 */
export function useWorktreeDiffStatsQuery(
  projectId: number | null,
  worktreePath: string | null,
  diffTarget: DiffTarget,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [...worktreeQueryKeys.base, "diff-stats", worktreePath ?? "", diffTarget] as const,
    queryFn: () => api.getWorktreeDiffStats(projectId!, worktreePath!, diffTarget),
    enabled: projectId != null && worktreePath != null,
    refetchInterval: options !== undefined ? options.refetchInterval : 10000,
    staleTime: 4000,
  });
}

/**
 * Mutation hook for deleting a worktree.
 * Passes optional worktreeId so DB row is deleted when present (orphans skip DB deletion).
 * Invalidates worktree list on success.
 */
export function useDeleteWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      worktreePath,
      branchName,
      worktreeId,
      deleteBranch,
    }: {
      projectId: number;
      worktreePath: string;
      branchName: string;
      worktreeId: number | null;
      deleteBranch: boolean;
    }) => {
      return await api.deleteWorktree(
        projectId,
        worktreePath,
        branchName,
        worktreeId,
        deleteBranch,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      toast.success("Worktree deleted");
    },
    onError: createErrorToastHandler("Failed to delete worktree"),
  });
}

/**
 * Mutation hook for cleaning up zombie worktrees on project open.
 * Silent on error — this is background housekeeping, not user-initiated.
 * Invalidates worktree list only when zombies were actually deleted.
 */
export function useCleanupZombieWorktreesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, repoPath }: { projectId: number; repoPath: string }) => {
      return await api.cleanupZombieWorktrees(projectId, repoPath);
    },
    onSuccess: (deletedCount) => {
      if (deletedCount > 0) {
        void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      }
    },
    onError: () => {
      // Silent: no toast — zombie cleanup is background housekeeping
    },
  });
}

/**
 * Session branches with no worktree and nothing on origin holding them.
 *
 * Keyed under `worktreeQueryKeys.base`, so removing a worktree — which is what frees its branch
 * — already refreshes this through the invalidations those mutations and the "worktrees-changed"
 * listener perform.
 */
export function usePrunableBranchesQuery(projectId: number | undefined) {
  return useQuery({
    queryKey: worktreeQueryKeys.prunableBranches(projectId ?? 0),
    queryFn: () => api.listPrunableBranches(projectId!),
    enabled: projectId != null,
  });
}

/**
 * Mutation hook for deleting the selected stale branches.
 *
 * `force` switches the backend from `git branch -d` to `-D`, and the caller sets it from whether
 * the selection includes an unmerged branch — the row the user ticked is the opt-in.
 */
export function usePruneBranchesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      branches,
      force,
    }: {
      projectId: number;
      branches: string[];
      force: boolean;
    }) => {
      return await api.pruneBranches(projectId, branches, force);
    },
    onSuccess: (deleted, { projectId, branches }) => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      // The base-branch picker reads its own list; without this it keeps offering deleted branches.
      void queryClient.invalidateQueries({
        queryKey: [...taskQueryKeys.base, "branches", projectId],
      });
      const plural = deleted.length === 1 ? "branch" : "branches";
      toast.success(
        deleted.length === branches.length
          ? `Pruned ${deleted.length} ${plural}`
          : `Pruned ${deleted.length} of ${branches.length} branches — see the log for the rest`,
      );
    },
    onError: createErrorToastHandler("Failed to prune branches"),
  });
}

/**
 * Mutation hook for creating a new worktree.
 * Accepts baseBranch and optional newBranchName (creates new branch from base).
 * When newBranchName is null, the existing baseBranch is checked out directly.
 * Invalidates worktree list on success.
 */
export function useCreateWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      taskId,
      baseBranch,
      newBranchName,
      repoPath,
    }: {
      projectId: number;
      taskId: number | null;
      baseBranch: string;
      newBranchName: string | null;
      repoPath: string;
    }) => {
      return await api.createWorktree(projectId, taskId, baseBranch, newBranchName, repoPath);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      toast.success("Worktree created");
    },
    onError: createErrorToastHandler("Failed to create worktree"),
  });
}

/**
 * One-shot query for checking if a worktree has dirty (uncommitted) changes.
 * Set `enabled: false` so it only runs via `refetch()`.
 */
export function useCheckWorktreeDirty(projectId: number | null, worktreePath: string | null) {
  return useQuery({
    queryKey: [...worktreeQueryKeys.base, "dirty", worktreePath] as const,
    queryFn: () => api.checkWorktreeDirty(projectId!, worktreePath!),
    enabled: false,
  });
}

/**
 * Query hook for fetching commits in a worktree relative to a base branch.
 * Returns CommitInfo[] wrapped in a Result type.
 */
export function useWorktreeCommitsQuery(
  projectId: number | null,
  worktreePath: string | null,
  baseBranch: string | null,
) {
  return useQuery({
    queryKey: [...worktreeQueryKeys.base, "commits", worktreePath, baseBranch] as const,
    queryFn: () => api.getWorktreeCommits(projectId!, worktreePath!, baseBranch!),
    enabled: projectId != null && worktreePath != null && baseBranch != null,
    staleTime: 10000,
  });
}
