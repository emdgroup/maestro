import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type { DiffTarget } from "@/types/bindings";

export const worktreeQueryKeys = {
  base: ["worktrees"] as const,
  list: (projectId: number) => [...worktreeQueryKeys.base, "list", projectId] as const,
  diff: (worktreePath: string, diffTarget: DiffTarget) =>
    [...worktreeQueryKeys.base, "diff", worktreePath, diffTarget] as const,
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
) {
  return useQuery({
    queryKey: worktreeQueryKeys.diff(worktreePath ?? "", diffTarget),
    queryFn: () => api.getWorktreeDiff(projectId!, worktreePath!, diffTarget),
    enabled: projectId != null && worktreePath != null,
    refetchInterval: 10000,
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
 * Mutation hook for staging files in a worktree.
 * Stages specific files (git add) and/or applies a patch (git apply --cached).
 * No automatic query invalidation — diff query polling handles refresh.
 */
export function useStageWorktreeFilesMutation() {
  return useMutation({
    mutationFn: async ({
      projectId,
      worktreePath,
      filePaths,
      patch,
    }: {
      projectId: number;
      worktreePath: string;
      filePaths: string[];
      patch: string | null;
    }) => {
      return await api.stageWorktreeFiles(projectId, worktreePath, filePaths, patch);
    },
    onError: createErrorToastHandler("Failed to stage files"),
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
      projectId,
      worktreePath,
      message,
    }: {
      projectId: number;
      worktreePath: string;
      message: string;
    }) => {
      return await api.commitWorktree(projectId, worktreePath, message);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      toast.success("Changes committed");
    },
    onError: createErrorToastHandler("Commit failed"),
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
      projectId,
      worktreePath,
      filePaths,
      patch,
    }: {
      projectId: number;
      worktreePath: string;
      filePaths: string[];
      patch: string | null;
    }) => {
      return await api.discardWorktreeChanges(projectId, worktreePath, filePaths, patch);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      toast.success("Changes discarded");
    },
    onError: createErrorToastHandler("Failed to discard changes"),
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
      projectId,
      worktreePath,
      stashName,
      filePaths,
    }: {
      projectId: number;
      worktreePath: string;
      stashName: string;
      filePaths: string[];
    }) => {
      return await api.shelveWorktreeChanges(projectId, worktreePath, stashName, filePaths);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      toast.success("Changes shelved");
    },
    onError: createErrorToastHandler("Failed to shelve changes"),
  });
}

/**
 * Mutation hook for deleting untracked files via `git clean -f`.
 * Used in the "Untracked Changes" mode of WorktreeDiffPanel to revert/discard untracked files.
 */
export function useDeleteUntrackedFilesMutation() {
  return useMutation({
    mutationFn: async ({
      projectId,
      worktreePath,
      filePaths,
    }: {
      projectId: number;
      worktreePath: string;
      filePaths: string[];
    }) => {
      return await api.deleteUntrackedFiles(projectId, worktreePath, filePaths);
    },
    onError: createErrorToastHandler("Failed to delete files"),
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
