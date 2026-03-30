import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib";
import { toast } from "sonner";

export const worktreeQueryKeys = {
  all: ["worktrees"] as const,
  list: (projectId: number) => [...worktreeQueryKeys.all, "list", projectId] as const,
  diff: (worktreeId: number) => [...worktreeQueryKeys.all, "diff", worktreeId] as const,
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
 */
export function useWorktreeDiffQuery(worktreeId: number | null) {
  return useQuery({
    queryKey: worktreeQueryKeys.diff(worktreeId ?? 0),
    queryFn: () => api.getWorktreeDiff(worktreeId!),
    enabled: worktreeId != null,
  });
}

/**
 * Mutation hook for deleting a worktree.
 * Invalidates worktree list on success.
 */
export function useDeleteWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ worktreeId, repoPath }: { worktreeId: number; repoPath: string }) => {
      return await api.deleteWorktree(worktreeId, repoPath);
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
 * Mutation hook for creating a new worktree.
 * Invalidates worktree list on success.
 */
export function useCreateWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      taskId,
      branchName,
      repoPath,
      worktreePath,
    }: {
      projectId: number;
      taskId: number | null;
      branchName: string;
      repoPath: string;
      worktreePath: string | null;
    }) => {
      return await api.createWorktree(projectId, taskId, branchName, repoPath, worktreePath);
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
