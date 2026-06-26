import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/utils/helpers/tauri-utils";
import type { Task, JsonValue, ConnectionKey } from "@/types/bindings";
import { useCreateWorktreeMutation, worktreeQueryKeys } from "@/services/worktree.service";
import { useSpawnAcpSessionMutation, useActiveSessionsQuery } from "@/services/execution.service";
import { useUpdateTask } from "@/services/task.service";
import { useDefaultAgent } from "@/store/configStore";
import type { DirtyChoice } from "@/components/execution/DirtyWorktreeDialog";

interface DirtyState {
  modifiedCount: number;
  untrackedCount: number;
  resolve: (choice: DirtyChoice | "cancel") => void;
}

export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connection: ConnectionKey,
) {
  const queryClient = useQueryClient();
  const defaultAgent = useDefaultAgent();
  const createWorktreeMutation = useCreateWorktreeMutation();
  const spawnAcpSessionMutation = useSpawnAcpSessionMutation();
  const updateTask = useUpdateTask();
  const [isExecuting, setIsExecuting] = useState(false);
  const [dirtyState, setDirtyState] = useState<DirtyState | null>(null);
  const dirtyResolveRef = useRef<((choice: DirtyChoice | "cancel") => void) | null>(null);

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

      // Check for dirty worktree
      try {
        const dirtyStatus = await api.checkWorktreeDirty(projectId, cwd);
        if (dirtyStatus.modified_count > 0 || dirtyStatus.untracked_count > 0) {
          const choice = await new Promise<DirtyChoice | "cancel">((resolve) => {
            dirtyResolveRef.current = resolve;
            setDirtyState({
              modifiedCount: dirtyStatus.modified_count,
              untrackedCount: dirtyStatus.untracked_count,
              resolve,
            });
          });
          setDirtyState(null);
          dirtyResolveRef.current = null;
          if (choice === "cancel") return;
          if (choice === "stash") await api.stashWorktree(projectId, cwd);
          if (choice === "discard") await api.discardAllWorktreeChanges(projectId, cwd);
        }
      } catch (err) {
        console.warn("Dirty worktree check failed, proceeding anyway:", err);
      }

      // Spawn ACP session
      const spawnResult = await spawnAcpSessionMutation.mutateAsync({
        agentId,
        cwd,
        sessionName: task.title,
        projectId,
        connection,
        worktreeBranch: branchName ?? null,
        taskId: task.id,
        taskName: task.title,
      });
      logId = spawnResult.log_id;

      let capturedModeIds: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unlistenSpawnOk();
          reject(new Error("Agent spawn timed out after 30s"));
        }, 30_000);

        let unlistenSpawnOk: () => void = () => {};
        let unlistenModes: () => void = () => {};

        listen<{ current_mode_id: string; available_modes: { mode_id: string }[] }>(
          `acp://session-modes/${logId}`,
          (e) => {
            capturedModeIds = e.payload.available_modes.map((m) => m.mode_id);
            unlistenModes();
          },
        ).then((fn) => {
          unlistenModes = fn;
        });

        listen<null>(`acp://spawn-ok/${logId}`, () => {
          clearTimeout(timer);
          unlistenSpawnOk();
          unlistenModes();
          resolve();
        }).then((fn) => {
          unlistenSpawnOk = fn;
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

      // Set permission mode: use override if set, otherwise resolve from modes received at spawn
      if (task.permission_mode_override) {
        try {
          await api.setAcpMode(logId, task.permission_mode_override);
        } catch (err) {
          console.warn("Failed to set permission mode override:", err);
        }
      } else if (capturedModeIds.length > 0) {
        try {
          const priorities = task.auto_approve
            ? ["bypassPermissions", "full-access", "auto"]
            : ["acceptEdits", "auto", "build"];
          const resolvedMode =
            priorities.find((m) => capturedModeIds.includes(m)) ??
            capturedModeIds.find((m) => m !== "readonly" && m !== "plan");
          if (resolvedMode) {
            await api.setAcpMode(logId, resolvedMode);
          }
        } catch (err) {
          console.warn("Failed to set permission mode:", err);
        }
      }

      // Build initial prompt content blocks
      const attachments = await api.listTaskAttachments(task.id);
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

      // Fetch review feedback for rework (if task was sent back with comments)
      try {
        const review = await api.getTaskReview(task.id);
        if (review && review.decision === "RequestChanges") {
          let feedbackText = "";

          if (review.comments.length > 0) {
            const grouped = new Map<string, string[]>();
            for (const c of review.comments) {
              const list = grouped.get(c.file_path) ?? [];
              list.push(c.comment);
              grouped.set(c.file_path, list);
            }
            for (const [filePath, comments] of grouped) {
              feedbackText += `## \`${filePath}\`\n`;
              comments.forEach((comment, i) => {
                feedbackText += `### Feedback #${i + 1}\n${comment}\n\n`;
              });
            }
          }

          if (review.general_feedback) {
            feedbackText += `## General feedback\n${review.general_feedback}\n`;
          }

          if (feedbackText) {
            contentBlocks.push({ type: "text", text: feedbackText });
          }
        }
      } catch {
        // Non-critical — proceed without review feedback
      }

      await api.sendAcpPromptStructured(logId, contentBlocks);

      // Clear review from DB after successful injection to prevent re-injection on next cold start
      api.clearTaskReview(task.id).catch(() => {});

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
      toast.error(`Execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExecuting(false);
    }
  };

  const onDirtyChoice = useCallback((choice: DirtyChoice) => {
    dirtyResolveRef.current?.(choice);
  }, []);

  const onDirtyCancel = useCallback(() => {
    dirtyResolveRef.current?.("cancel");
  }, []);

  return {
    execute,
    isExecuting,
    dirtyDialogOpen: dirtyState !== null,
    dirtyModifiedCount: dirtyState?.modifiedCount ?? 0,
    dirtyUntrackedCount: dirtyState?.untrackedCount ?? 0,
    onDirtyChoice,
    onDirtyCancel,
  };
}

export function useTaskActiveSession(taskId: number | null, projectId: number | null) {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId ?? undefined);
  if (taskId === null) return null;
  return sessions.find((s) => s.task_id === taskId) ?? null;
}
