import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib";
import { toast } from "sonner";
import type { DiffTarget } from "@/types/bindings";

export const worktreeQueryKeys = {
  all: ["worktrees"] as const,
  list: (projectId: number) => [...worktreeQueryKeys.all, "list", projectId] as const,
  diff: (worktreeId: number, diffTarget: DiffTarget) =>
    [...worktreeQueryKeys.all, "diff", worktreeId, diffTarget] as const,
};

/**
 * Query hook for fetching worktrees with status for a project.
 * Polls every 5 seconds for live updates in the Worktrees view.
 */
export function useWorktreesQuery(projectId: number | undefined, repoPath: string | undefined) {
  return useQuery({
    queryKey: worktreeQueryKeys.list(projectId ?? 0),
    queryFn: () => api.listWorktreesWithStatus(projectId!, repoPath!),
    enabled: projectId != null && repoPath != null,
    refetchInterval: 5000,
  });
}

/**
 * Query hook for fetching worktree diff (unified diff string).
 * Only fetches when a worktree is selected (worktreeId is non-null).
 * diffTarget controls whether we diff HEAD (uncommitted) or a branch (full branch diff).
 */
export function useWorktreeDiffQuery(worktreeId: number | null, diffTarget: DiffTarget) {
  return useQuery({
    queryKey: worktreeQueryKeys.diff(worktreeId ?? 0, diffTarget),
    queryFn: () => api.getWorktreeDiff(worktreeId!, diffTarget),
    enabled: worktreeId != null,
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

/**
 * Mutation hook for deleting a worktree.
 * Invalidates worktree list on success.
 */
export function useDeleteWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      worktreeId,
      repoPath,
      deleteBranch,
    }: {
      worktreeId: number;
      repoPath: string;
      deleteBranch: boolean;
    }) => {
      return await api.deleteWorktree(worktreeId, repoPath, deleteBranch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Worktree deleted");
    },
    onError: (error) => {
      toast.error(`Failed to delete worktree: ${error}`);
    },
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
        queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
        console.log(`[DEBUG] cleanup_zombie_worktrees: removed ${deletedCount} zombie worktrees`);
      }
    },
    onError: (error) => {
      console.error("[DEBUG] cleanup_zombie_worktrees failed:", error);
      // Silent: no toast — zombie cleanup is background housekeeping
    },
  });
}

/**
 * Mutation hook for creating a new worktree.
 * Accepts originBranch (base branch) and optional newBranchName (creates new branch from origin).
 * When newBranchName is null, the existing originBranch is checked out directly.
 * Invalidates worktree list on success.
 */
export function useCreateWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      taskId,
      originBranch,
      newBranchName,
      repoPath,
    }: {
      projectId: number;
      taskId: number | null;
      originBranch: string;
      newBranchName: string | null;
      repoPath: string;
    }) => {
      return await api.createWorktree(projectId, taskId, originBranch, newBranchName, repoPath);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Worktree created");
    },
    onError: (error) => {
      toast.error(`Failed to create worktree: ${error}`);
    },
  });
}
