import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/utils/helpers/tauri-utils";
import { useCreateWorktreeMutation, worktreeQueryKeys } from "@/services/worktree.service";

/** A worktree created for a session, so the caller can clean it up on close. */
export interface CreatedWorktree {
  id: number;
  path: string;
  branchName: string;
}

export interface ResolvedWorktree {
  /** Directory the session runs in. */
  cwd: string;
  branchName: string;
  /** Null when an existing worktree was reused — only a fresh one needs cleaning up. */
  created: CreatedWorktree | null;
}

interface ResolveWorktreeArgs {
  projectId: number;
  repoPath: string;
  /** Non-null reuses the worktree already attached to that task, if there is one. */
  taskId: number | null;
  baseBranch: string;
  /** Null checks `baseBranch` out where it is rather than branching from it. */
  newBranchName: string | null;
  /**
   * Whether the backend may append its row id to keep `newBranchName` unique. True for a generated
   * name, false for one the user typed — see `create_worktree`.
   */
  uniqueSuffix?: boolean;
}

/**
 * Resolves the worktree a session runs in, creating one when there is nothing to reuse.
 * Callers that can run without a worktree keep that branch themselves — it is a plain
 * path, not an operation.
 */
export function useResolveWorktree() {
  const queryClient = useQueryClient();
  const createWorktreeMutation = useCreateWorktreeMutation();

  const resolveWorktree = async ({
    projectId,
    repoPath,
    taskId,
    baseBranch,
    newBranchName,
    uniqueSuffix = false,
  }: ResolveWorktreeArgs): Promise<ResolvedWorktree> => {
    if (taskId !== null) {
      const worktrees = await queryClient.fetchQuery({
        queryKey: worktreeQueryKeys.list(projectId),
        queryFn: () => api.listWorktreesWithStatus(projectId, repoPath),
      });
      const existing = worktrees.find((w) => w.task_id === taskId);
      if (existing && existing.id != null) {
        return { cwd: existing.path, branchName: existing.branch_name, created: null };
      }
    }

    const row = await createWorktreeMutation.mutateAsync({
      projectId,
      taskId,
      baseBranch,
      newBranchName,
      uniqueSuffix,
      repoPath,
    });
    const cwd = `${repoPath}/${row.path}`;
    return {
      cwd,
      branchName: row.branch_name,
      created: { id: row.id, path: cwd, branchName: row.branch_name },
    };
  };

  return { resolveWorktree, isCreatingWorktree: createWorktreeMutation.isPending };
}
