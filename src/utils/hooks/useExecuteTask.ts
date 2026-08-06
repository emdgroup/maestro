import { useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/utils/helpers/tauri-utils";
import { slugifyName } from "@/lib/generateSessionName";
import type { Task, JsonValue, ConnectionKey } from "@/types/bindings";
import { useResolveWorktree } from "@/utils/hooks/useResolveWorktree";
import { useSpawnAcpSessionMutation, useActiveSessionsQuery } from "@/services/execution.service";
import {
  useMarkTaskExecutionStartedMutation,
  useMarkTaskSessionReadyMutation,
  useReleaseTaskExecutionClaimMutation,
} from "@/services/task.service";
import { useDefaultAgent } from "@/store/configStore";
import { useBoardStore } from "@/store/boardStore";
import type { DirtyChoice } from "@/components/execution/DirtyWorktreeDialog";

interface DirtyState {
  modifiedCount: number;
  untrackedCount: number;
  resolve: (choice: DirtyChoice | "cancel") => void;
}

/// Tells the agent how to signal that the task is finished.
///
/// Without it the board can only guess from whether the repository changed, which misreads an
/// agent that edits some files and then stops to ask a question. Kept to a single line at the end
/// of the prompt: it is short enough to read as an instruction rather than noise, and the agent's
/// own marker is stripped from its reply by `acp/completion.rs` so the transcript stays clean.
const COMPLETION_PROTOCOL =
  "When the task is complete and needs no further work, end your final message with `<maestro-task-complete/>` — " +
  "it moves the task to review, so omit it if you are asking a question or reporting a blocker.";

export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connection: ConnectionKey,
) {
  const defaultAgent = useDefaultAgent();
  const { resolveWorktree } = useResolveWorktree();
  const spawnAcpSessionMutation = useSpawnAcpSessionMutation();
  const markExecutionStarted = useMarkTaskExecutionStartedMutation();
  const markSessionReady = useMarkTaskSessionReadyMutation();
  const releaseClaim = useReleaseTaskExecutionClaimMutation();
  const [isExecuting, setIsExecuting] = useState(false);
  const [dirtyState, setDirtyState] = useState<DirtyState | null>(null);
  const dirtyResolveRef = useRef<((choice: DirtyChoice | "cancel") => void) | null>(null);

  const execute = async (task: Task) => {
    if (!projectId) return;

    // Resolution order is profile → project override → task override, so the task wins where it
    // says something. Asked for before the capabilities are known because the agent it names is
    // what gets spawned; the model and mode are applied afterwards, once the agent has reported
    // what it supports.
    const coderProfile = await api
      .resolveAgentProfile(projectId, "Coder", null, [], [], false)
      .catch(() => null);

    const agentId = task.agent_id ?? coderProfile?.agent_id ?? defaultAgent;
    if (!agentId) {
      toast.error("No agent configured. Set a default agent in Settings.");
      return;
    }

    // Claim before anything is built. The claim marks the task `Spawning`, which is what stops a
    // second click or the auto-mode drain from starting the same task twice, and what makes the
    // in-flight state visible instead of leaving the card looking untouched for the whole spawn.
    //
    // Null means the task is not startable — already being spawned, or moved since the button was
    // rendered. Nothing has been created yet, so there is nothing to tear down.
    const claimed = await markExecutionStarted.mutateAsync(task.id);
    if (!claimed) {
      toast.info(`"${task.title}" is no longer waiting to start`);
      return;
    }

    setIsExecuting(true);
    let logId: number | null = null;
    // Set once the task owns a live session; until then any exit has to hand the claim back.
    let claimHandedOver = false;
    let spawnFailed = false;

    try {
      // Resolve cwd and branch
      const { cwd, branchName } = task.isolated_worktree
        ? await resolveWorktree({
            projectId,
            repoPath: projectPath,
            taskId: task.id,
            baseBranch: task.base_branch,
            newBranchName: `${task.id}-${slugifyName(task.title)}`,
          })
        : { cwd: projectPath, branchName: null };

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
          unlistenSessionError();
          reject(new Error("Agent spawn timed out after 30s"));
        }, 30_000);

        let unlistenSpawnOk: () => void = () => {};
        let unlistenModes: () => void = () => {};
        let unlistenSessionError: () => void = () => {};

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
          unlistenSessionError();
          resolve();
        }).then((fn) => {
          unlistenSpawnOk = fn;
        });

        listen<string>(`acp://session-error/${logId}`, (e) => {
          clearTimeout(timer);
          unlistenSpawnOk();
          unlistenModes();
          unlistenSessionError();
          reject(new Error(e.payload));
        }).then((fn) => {
          unlistenSessionError = fn;
        });
      });

      // Asked again now that the agent has said what it supports, so anything it cannot honour is
      // dropped with a warning rather than being sent and silently failing.
      const resolved = await api
        .resolveAgentProfile(projectId, "Coder", null, [], capturedModeIds, false)
        .catch(() => null);

      for (const warning of resolved?.warnings ?? []) {
        toast.warning(warning);
      }

      const model = task.model_override ?? resolved?.model ?? null;
      if (model) {
        try {
          await api.setAcpModel(logId, model);
        } catch (err) {
          console.warn("Failed to set model:", err);
        }
      }

      // Set permission mode: task override, then the profile, then the modes received at spawn
      const permissionMode = task.permission_mode_override ?? resolved?.permission_mode ?? null;
      if (permissionMode) {
        try {
          await api.setAcpMode(logId, permissionMode);
        } catch (err) {
          console.warn("Failed to set permission mode:", err);
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
      // Ahead of the task, because it says what this role means for this project — the standing
      // instruction the task is an instance of, not a footnote to it.
      const rolePrompt = resolved?.role_prompt ? `${resolved.role_prompt}\n\n---\n` : "";
      contentBlocks.push({
        type: "text",
        text: `${rolePrompt}${promptText}\n\n---\n${COMPLETION_PROTOCOL}`,
      });

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

      // The session is up and prompted, so the task moves to In Progress. Null means it stopped
      // being the task we claimed — the user dragged or stopped it while the spawn was in flight.
      // Their action wins, so the session we just built gets torn down instead.
      const started = await markSessionReady.mutateAsync(task.id);
      if (!started) {
        api.cancelAcpSession(logId).catch((err) => {
          console.error("Failed to cancel the session of a task that moved mid-spawn:", err);
        });
        toast.info(`"${task.title}" was moved while starting — session cancelled`);
        return;
      }

      claimHandedOver = true;
      toast.success(`Session started for "${task.title}"`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg === "auth_required") {
        // Remove zombie session but keep the connection server alive for authentication.
        api.discardFailedSpawn(logId!).catch(() => {});
        useBoardStore.getState().setAuthRequired(task.id, agentId!, connection, null);
        return;
      }

      spawnFailed = true;

      if (logId !== null) {
        try {
          await api.cancelAcpSession(logId);
        } catch {
          // best-effort
        }
      }
      toast.error(`Execution failed: ${errorMsg}`);
    } finally {
      // Every exit that did not hand the task a live session gives the claim back — the dirty
      // dialog being cancelled, an auth prompt, a spawn error, or the task having moved. Leaving
      // it claimed would park the card at `Spawning` forever with nothing left to move it on, and
      // the queue drain skips exactly that state.
      //
      // Only a failure leaves the card red: cancelling at a prompt is not something to report.
      if (!claimHandedOver) {
        releaseClaim
          .mutateAsync({ taskId: task.id, failed: spawnFailed })
          .catch((err) => console.error("Failed to release the execution claim:", err));
      }
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
