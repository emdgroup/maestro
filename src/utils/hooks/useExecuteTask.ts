import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/utils/helpers/tauri-utils";
import type { Task, JsonValue } from "@/types/bindings";
import { useCreateWorktreeMutation, worktreeQueryKeys } from "@/services/worktree.service";
import {
  useSpawnAcpSessionMutation,
  useActiveSessionsQuery,
} from "@/services/execution.service";
import { useUpdateTask } from "@/services/task.service";
import { useDefaultAgent } from "@/store/configStore";

export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connectionId: number | null,
  wslConnectionId: number | null,
) {
  const queryClient = useQueryClient();
  const defaultAgent = useDefaultAgent();
  const createWorktreeMutation = useCreateWorktreeMutation();
  const spawnAcpSessionMutation = useSpawnAcpSessionMutation();
  const updateTask = useUpdateTask();
  const [isExecuting, setIsExecuting] = useState(false);

  const execute = async (task: Task) => {
    if (!projectId) return;

    const agentId = task.agent_id ?? defaultAgent;
    if (!agentId) {
      toast.error("No agent configured. Set a default agent in Settings.");
      return;
    }

    setIsExecuting(true);
    let logId: number | null = null;

    try {
      // Resolve cwd and branch
      let cwd: string;
      let branchName: string | undefined;

      if (task.isolated_worktree) {
        const worktrees = await queryClient.fetchQuery({
          queryKey: worktreeQueryKeys.list(projectId),
          queryFn: () => api.listWorktreesWithStatus(projectId, projectPath),
        });
        const existingWorktree = worktrees.find((w) => w.task_id === task.id);

        if (existingWorktree && existingWorktree.id != null) {
          cwd = existingWorktree.path;
          branchName = existingWorktree.branch_name;
        } else {
          const slug = task.title
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
          cwd = `${projectPath}/${worktree.path}`;
          branchName = worktree.branch_name;
        }
      } else {
        cwd = projectPath;
      }

      // Spawn ACP session
      logId = await spawnAcpSessionMutation.mutateAsync({
        agentId,
        cwd,
        sessionName: task.title,
        projectId,
        connectionId,
        wslConnectionId,
        worktreeBranch: branchName ?? null,
        taskId: task.id,
        taskName: task.title,
      });

      // Wait for spawn-ok (30s timeout)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unlisten();
          reject(new Error("Agent spawn timed out after 30s"));
        }, 30_000);

        let unlisten: () => void = () => {};
        listen<null>(`acp://spawn-ok/${logId}`, () => {
          clearTimeout(timer);
          unlisten();
          resolve();
        }).then((fn) => {
          unlisten = fn;
        });
      });

      // Set model if overridden (non-critical — log warning on failure)
      if (task.model_override) {
        try {
          await api.setAcpModel(logId, task.model_override);
        } catch (err) {
          console.warn("Failed to set model override:", err);
        }
      }

      // Build initial prompt content blocks
      const attachments = await api.getTaskAttachments(task.id);
      const contentBlocks: JsonValue[] = [];

      const promptText = task.description
        ? `# ${task.title}\n\n${task.description}`
        : `# ${task.title}`;
      contentBlocks.push({ type: "text", text: promptText });

      if (attachments.length > 0) {
        const files = attachments.map((a) => ({ path: a.file_path, is_image: false }));
        const prepared = await api.prepareExternalAttachments(logId, files, true);
        for (const attachment of prepared) {
          contentBlocks.push(attachment.content_block as JsonValue);
        }
      }

      await api.sendAcpPromptStructured(logId, contentBlocks);

      // Transition task to InProgress
      await updateTask.mutateAsync({ taskId: task.id, updates: { status: "InProgress" } });

      toast.success(`Session started for "${task.title}"`);
    } catch (error) {
      if (logId !== null) {
        try {
          await api.cancelAcpSession(logId);
        } catch {
          // best-effort
        }
      }
      toast.error(
        `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsExecuting(false);
    }
  };

  return { execute, isExecuting };
}

export function useTaskActiveSession(taskId: number | null, projectId: number | null) {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId ?? undefined);
  if (taskId === null) return null;
  return sessions.find((s) => s.task_id === taskId) ?? null;
}
