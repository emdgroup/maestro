import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib";
import type { Task } from "@/types/bindings";

export function useExecuteTask(projectId: number | null, projectPath: string) {
  const [isExecuting, setIsExecuting] = useState(false);

  const execute = async (task: Task) => {
    if (!projectId) return;
    setIsExecuting(true);
    try {
      const worktrees = await api.listWorktreesWithStatus(projectId, projectPath);
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
        const newBranchName = `${task.id}-${slug}`;
        const worktree = await api.createWorktree(
          projectId,
          task.id,
          task.base_branch,
          newBranchName,
          projectPath,
        );
        worktreeId = worktree.id;
        branchName = worktree.branch_name;
      }

      await api.spawnInteractiveExecution(
        projectId,
        branchName,
        projectPath,
        task.name,
        worktreeId,
        task.id,
        task.description,
      );
      toast.success(`Session started for "${task.name}"`);
    } catch (error) {
      toast.error(`Execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExecuting(false);
    }
  };

  return { execute, isExecuting };
}
