import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import type { Task } from "@/types/bindings";
import { useCreateWorktreeMutation, worktreeQueryKeys } from "@/services/worktree.service";
import { useSpawnInteractiveExecutionMutation } from "@/services/execution.service";

export function useExecuteTask(projectId: number | null, projectPath: string) {
  const queryClient = useQueryClient();
  const createWorktreeMutation = useCreateWorktreeMutation();
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const [isExecuting, setIsExecuting] = useState(false);

  const execute = async (task: Task) => {
    if (!projectId) return;
    setIsExecuting(true);
    try {
      const worktrees = await queryClient.fetchQuery({
        queryKey: worktreeQueryKeys.list(projectId),
        queryFn: () => api.listWorktreesWithStatus(projectId, projectPath),
      });
      const existingWorktree = worktrees.find((w) => w.task_id === task.id);

      let worktreeId: number;
      let branchName: string;

      if (existingWorktree && existingWorktree.id != null) {
        worktreeId = existingWorktree.id;
        branchName = existingWorktree.branch_name;
      } else {
        const slug = task.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 50);
        const worktree = await createWorktreeMutation.mutateAsync({
          projectId,
          taskId: task.id,
          baseBranch: task.base_branch,
          newBranchName: `${task.id}-${slug}`,
          repoPath: projectPath,
        });
        worktreeId = worktree.id;
        branchName = worktree.branch_name;
      }

      await spawnMutation.mutateAsync({
        projectId,
        branchName,
        repoPath: projectPath,
        sessionName: task.name,
        worktreeId,
        taskId: task.id,
        taskDescription: task.description,
      });
      toast.success(`Session started for "${task.name}"`);
    } catch (error) {
      toast.error(`Execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return { execute, isExecuting };
}
