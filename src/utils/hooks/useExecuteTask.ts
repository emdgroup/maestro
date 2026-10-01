import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { parseProfileOverrides, profileIdFor } from "@/lib/profile-overrides";
import type { Task, ConnectionKey, AgentRole, WorktreeWithStatus } from "@/types/bindings";
import { worktreeQueryKeys } from "@/services/worktree.service";
import { useActiveSessionsQuery, useAgentDiscoveryQuery } from "@/services/execution.service";
import { startTask } from "@/services/task.service";
import { useProjectSettings } from "@/services/project.service";
import { useNavigationActions } from "@/store/navigationStore";
import { useBoardStore } from "@/store/boardStore";
import type { DirtyChoice } from "@/components/execution/DirtyWorktreeDialog";

interface DirtyState {
  modifiedCount: number;
  untrackedCount: number;
  resolve: (choice: DirtyChoice | "cancel") => void;
}

/** The task waiting on an agent to be chosen for it, and the promise that choice settles. */
interface AgentPickerState {
  task: Task;
  resolve: (agentId: string | null) => void;
}

/** The daemon's refusals for a stage with no agent it can spawn (`task_runner::begin`). */
function isNoAgentError(message: string): boolean {
  return message.startsWith("No agent to run") || message.includes("is unknown on this machine");
}

/**
 * Starts a task's stage. The daemon does the work, from the claim to the prompt (`start_task`);
 * what is left here is what only a person at the board can answer: the dirty-worktree question,
 * the agent picker, and the sign-in prompt.
 */
export function useExecuteTask(
  projectId: number | null,
  projectPath: string,
  connection: ConnectionKey,
) {
  const defaultAgent = useProjectSettings(projectId).data?.default_agent ?? null;
  const queryClient = useQueryClient();
  // Which task is mid-start, not merely that one is: the board shares one instance across cards.
  const [executingTaskId, setExecutingTaskId] = useState<number | null>(null);
  const [dirtyState, setDirtyState] = useState<DirtyState | null>(null);
  const dirtyResolveRef = useRef<((choice: DirtyChoice | "cancel") => void) | null>(null);
  const [agentPickerState, setAgentPickerState] = useState<AgentPickerState | null>(null);
  const agentPickerResolveRef = useRef<((agentId: string | null) => void) | null>(null);
  const { data: discovery } = useAgentDiscoveryQuery(connection, projectId != null);
  const navigation = useNavigationActions();

  /**
   * The folder a coder would write in, when it already exists: the project itself, the pinned
   * workspace, or the task's own worktree from an earlier round. A worktree not made yet is clean.
   */
  const existingWorkspace = async (task: Task, id: number): Promise<string | null> => {
    if (task.workspace_mode === "RepositoryDirectory") return projectPath;
    const worktrees = await queryClient
      .fetchQuery({
        queryKey: worktreeQueryKeys.list(id),
        queryFn: () => api.listWorktreesWithStatus(id, projectPath),
      })
      .catch(() => [] as WorktreeWithStatus[]);
    const found =
      task.workspace_mode === "ReuseWorkspace"
        ? worktrees.find((w) => w.id != null && w.id === task.workspace_worktree_id)
        : worktrees.find((w) => w.task_id === task.id);
    return found?.path ?? null;
  };

  /**
   * Asks about uncommitted work before a coder builds on it. Only on a click: the daemon's
   * unattended starts skip it, and the work a handoff finds is the task's own. False means the
   * user cancelled.
   */
  const settleDirtyWorkspace = async (task: Task, id: number): Promise<boolean> => {
    try {
      const cwd = await existingWorkspace(task, id);
      if (!cwd) return true;
      const status = await api.checkWorktreeDirty(id, cwd);
      if (status.modified_count === 0 && status.untracked_count === 0) return true;
      const choice = await new Promise<DirtyChoice | "cancel">((resolve) => {
        dirtyResolveRef.current = resolve;
        setDirtyState({
          modifiedCount: status.modified_count,
          untrackedCount: status.untracked_count,
          resolve,
        });
      });
      setDirtyState(null);
      dirtyResolveRef.current = null;
      if (choice === "cancel") return false;
      if (choice === "stash") await api.stashWorktree(id, cwd);
      if (choice === "discard") await api.discardAllWorktreeChanges(id, cwd);
    } catch (err) {
      console.warn("Dirty worktree check failed, proceeding anyway:", err);
    }
    return true;
  };

  /** The agent a sign-in is for. The daemon's `auth_required` does not name it. */
  const agentFor = async (task: Task, role: AgentRole, id: number): Promise<string | null> => {
    if (role === "Coder" && task.agent_id) return task.agent_id;
    const profile = await api
      .resolveAgentProfile(
        id,
        role,
        profileIdFor(parseProfileOverrides(task.profile_overrides), role),
        [],
        [],
        true,
      )
      .catch(() => null);
    return profile?.agent_id ?? defaultAgent;
  };

  const openAgentSettings = {
    label: "Open agent settings",
    onClick: () => navigation.openSettings("agents"),
  };

  const execute = async (
    task: Task,
    {
      /** Defer to the queue when the host is full. The Execute button's, not a gate's. */
      respectCapacity = false,
      role = "Coder" as AgentRole,
      /** What the user wrote at a gate, for the prompt this run is about to get. */
      feedback = "",
      /** Nobody is there to answer: the daemon notes refusals in the thread instead. */
      unattended = false,
      /** The caller renders `AgentPickerModal` from the state returned below. */
      canPickAgent = false,
    } = {},
  ) => {
    if (!projectId) return;
    const id = projectId;
    if (role === "Coder" && !unattended && !(await settleDirtyWorkspace(task, id))) return;

    setExecutingTaskId(task.id);
    const start = () =>
      startTask(id, task.id, role, feedback.trim() || null, unattended, respectCapacity);
    try {
      let sessionId: string | null;
      try {
        sessionId = await start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const installed = discovery?.agents ?? [];
        if (!isNoAgentError(message) || !canPickAgent || installed.length === 0) throw error;
        // The picker writes its choice onto the task, and onto the project default when asked,
        // which is where the daemon reads it from, so the start is simply asked for again.
        const picked = await new Promise<string | null>((resolve) => {
          agentPickerResolveRef.current = resolve;
          setAgentPickerState({ task, resolve });
        });
        setAgentPickerState(null);
        agentPickerResolveRef.current = null;
        if (!picked) return;
        sessionId = await start();
      }

      if (sessionId === null) {
        toast.info(`"${task.title}" will start when an agent is free`);
        return;
      }
      toast.success(`Session started for "${task.title}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "auth_required" || message.startsWith("auth_required:")) {
        // The daemon names the agent as `auth_required:<agent_id>`.
        const agentId = message.split(":")[1] || (await agentFor(task, role, id));
        if (agentId) {
          useBoardStore.getState().setAuthRequired(String(task.id), agentId, connection, null);
          return;
        }
      }
      if (isNoAgentError(message)) {
        if ((discovery?.agents ?? []).length === 0) {
          toast.error(`No coding agent is installed for "${task.title}"`, {
            description:
              "Maestro found no agent on this project's connection. Install one, such as Claude " +
              "Code, Codex or Gemini, and it appears in the agent settings.",
            action: openAgentSettings,
          });
        } else {
          toast.error(message, { action: openAgentSettings });
        }
        return;
      }
      toast.error(`Execution failed: ${message}`);
    } finally {
      setExecutingTaskId((current) => (current === task.id ? null : current));
    }
  };

  const onDirtyChoice = useCallback((choice: DirtyChoice) => {
    dirtyResolveRef.current?.(choice);
  }, []);

  const onDirtyCancel = useCallback(() => {
    dirtyResolveRef.current?.("cancel");
  }, []);

  const onAgentPicked = useCallback((agentId: string) => {
    agentPickerResolveRef.current?.(agentId);
  }, []);

  const onAgentPickerCancel = useCallback(() => {
    agentPickerResolveRef.current?.(null);
  }, []);

  return {
    execute,
    /** The task mid-start, for a caller rendering more than one card off one instance of this hook. */
    executingTaskId,
    /** The same fact for the callers that only ever drive one task. */
    isExecuting: executingTaskId !== null,
    dirtyDialogOpen: dirtyState !== null,
    dirtyModifiedCount: dirtyState?.modifiedCount ?? 0,
    dirtyUntrackedCount: dirtyState?.untrackedCount ?? 0,
    onDirtyChoice,
    onDirtyCancel,
    /** Only ever set for a caller that passed `canPickAgent`. */
    agentPickerTask: agentPickerState?.task ?? null,
    onAgentPicked,
    onAgentPickerCancel,
  };
}

export function useTaskActiveSession(taskId: number | null, projectId: number | null) {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId ?? undefined);
  if (taskId === null) return null;
  return sessions.find((s) => s.task_id === taskId) ?? null;
}
