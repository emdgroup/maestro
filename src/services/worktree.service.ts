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
 * Mutation hook for staging files in a worktree.
 * Stages specific files (git add) and/or applies a patch (git apply --cached).
 * No automatic query invalidation — the 5s polling interval handles refresh.
 */
export function useStageWorktreeFilesMutation() {
  return useMutation({
    mutationFn: async ({
      worktreeId,
      filePaths,
      patch,
    }: {
      worktreeId: number;
      filePaths: string[];
      patch: string | null;
    }) => {
      return await api.stageWorktreeFiles(worktreeId, filePaths, patch);
    },
    onError: (error) => {
      toast.error(`Failed to stage files: ${error}`);
    },
  });
}

/**
 * Mutation hook for committing staged changes in a worktree.
 * Invalidates both worktree list and diff queries on success.
 */
export function useCommitWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      worktreeId,
      message,
    }: {
      worktreeId: number;
      message: string;
    }) => {
      return await api.commitWorktree(worktreeId, message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Changes committed");
    },
    onError: (error) => {
      toast.error(`Commit failed: ${error}`);
    },
  });
}

/**
 * Mutation hook for discarding (reverting) changes in a worktree.
 * Handles both whole-file discard (git reset + checkout) and hunk-level (git apply --reverse).
 * Invalidates all worktree queries on success.
 */
export function useDiscardWorktreeChangesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      worktreeId,
      filePaths,
      patch,
    }: {
      worktreeId: number;
      filePaths: string[];
      patch: string | null;
    }) => {
      return await api.discardWorktreeChanges(worktreeId, filePaths, patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Changes discarded");
    },
    onError: (error) => {
      toast.error(`Failed to discard changes: ${error}`);
    },
  });
}

/**
 * Mutation hook for shelving (stashing) changes in a worktree.
 * Runs git stash push with optional file paths and a named message.
 * Invalidates all worktree queries on success.
 */
export function useShelveWorktreeChangesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      worktreeId,
      stashName,
      filePaths,
    }: {
      worktreeId: number;
      stashName: string;
      filePaths: string[];
    }) => {
      return await api.shelveWorktreeChanges(worktreeId, stashName, filePaths);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Changes shelved");
    },
    onError: (error) => {
      toast.error(`Failed to shelve changes: ${error}`);
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
