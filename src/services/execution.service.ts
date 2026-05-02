import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib";
import { toast } from "sonner";
import { Channel as TAURI_CHANNEL } from "@tauri-apps/api/core";

/**
 * Execution service providing type-safe operations for task execution and terminal management.
 * All execution and terminal-related IPC calls are centralized here.
 */

/**
 * Query key factory for execution operations
 * Execution operations are primarily side-effects; included for consistency
 */
export const executionQueryKeys = {
  all: ["executions"] as const,
  details: () => [...executionQueryKeys.all, "detail"] as const,
  detail: (executionId: number) => [...executionQueryKeys.details(), executionId] as const,
  withTaskInfo: (projectId: number) =>
    [...executionQueryKeys.all, "withTaskInfo", projectId] as const,
  structuredOutput: (logId: number) =>
    [...executionQueryKeys.all, "structuredOutput", logId] as const,
};

/**
 * Query hook for fetching executions with linked task info.
 * Polls every 2 seconds for live updates in the Agents view sidebar.
 */
export function useExecutionsWithTaskInfoQuery(projectId: number | undefined) {
  return useQuery({
    queryKey: executionQueryKeys.withTaskInfo(projectId ?? 0),
    queryFn: () => api.listExecutionsWithTaskInfo(projectId!),
    enabled: projectId != null,
    refetchInterval: 2000,
  });
}

/**
 * Mutation hook for spawning agent execution
 * @deprecated Use useSpawnInteractiveExecutionMutation instead.
 * The sidecar-based spawn_agent_execution IPC has been removed.
 */
export function useSpawnExecutionMutation() {
  return useMutation({
    mutationFn: async (_args: {
      projectId: number;
      taskId: number;
      repoPath: string;
    }) => {
      throw new Error(
        "spawn_agent_execution has been removed. Use spawnInteractiveExecution instead."
      );
    },
    onError: (error) => {
      toast.error(`Failed to spawn execution: ${error}`);
    },
  });
}

/**
 * Mutation hook for spawning an interactive (task-free) PTY session on a branch.
 * Returns the log_id which can be used as the session key for attach_terminal.
 *
 * taskId and taskDescription are optional — callers from AgentsView omit them,
 * callers from TaskCard pass them to wire task context into the session.
 */
export function useSpawnInteractiveExecutionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      branchName,
      repoPath,
      sessionName,
      worktreeId,
      taskId,
      taskDescription,
    }: {
      projectId: number;
      branchName: string;
      repoPath: string;
      sessionName: string | null;
      worktreeId?: number | null;
      taskId?: number | null;
      taskDescription?: string | null;
    }) => {
      return await api.spawnInteractiveExecution(
        projectId, branchName, repoPath, sessionName,
        worktreeId ?? null, taskId ?? null, taskDescription ?? null
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error(`Failed to spawn interactive session: ${error}`);
    },
  });
}

/**
 * Mutation hook for renaming an execution (updating its session_name).
 */
export function useRenameExecutionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ executionId, sessionName }: { executionId: number; sessionName: string }) => {
      return await api.renameExecution(executionId, sessionName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
    },
    onError: (error) => {
      toast.error(`Failed to rename session: ${error}`);
    },
  });
}

/**
 * Mutation hook for deleting an execution log (and cleaning up its PTY session)
 */
export function useDeleteExecutionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ executionId }: { executionId: number }) => {
      return await api.deleteExecutionLog(executionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
      toast.success("Session deleted");
    },
    onError: (error) => {
      toast.error(`Failed to delete session: ${error}`);
    },
  });
}

/**
 * Mutation hook for pausing execution
 */
export function usePauseExecutionMutation() {
  return useMutation({
    mutationFn: async ({ taskId }: { taskId: number }) => {
      return await api.pauseAgentExecution(taskId);
    },
    onError: (error) => {
      toast.error(`Failed to pause execution: ${error}`);
    },
  });
}

/**
 * Mutation hook for resuming execution
 */
export function useResumeExecutionMutation() {
  return useMutation({
    mutationFn: async ({
      taskId,
      projectId,
      repoPath,
    }: {
      taskId: number;
      projectId: number;
      repoPath: string;
    }) => {
      return await api.resumeAgentExecution(taskId, projectId, repoPath);
    },
    onError: (error) => {
      toast.error(`Failed to resume execution: ${error}`);
    },
  });
}

/**
 * Mutation hook for attaching to execution terminal
 */
export function useAttachTerminalMutation() {
  return useMutation({
    mutationFn: async ({
      taskId,
      outputChannel,
    }: {
      taskId: number;
      outputChannel: TAURI_CHANNEL<string>;
    }) => {
      return await api.attachTerminal(taskId, outputChannel, null);
    },
    onError: (error) => {
      toast.error(`Failed to attach terminal: ${error}`);
    },
  });
}

/**
 * Mutation hook for detaching from execution terminal
 */
export function useDetachTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId }: { taskId: number }) => {
      return await api.detachTerminal(taskId);
    },
    onError: (error) => {
      toast.error(`Failed to detach terminal: ${error}`);
    },
  });
}

/**
 * Mutation hook for sending input to execution terminal
 */
export function useSendTerminalInputMutation() {
  return useMutation({
    mutationFn: async ({ taskId, input }: { taskId: number; input: string }) => {
      return await api.sendTerminalInput(taskId, input);
    },
    onError: (error) => {
      toast.error(`Failed to send terminal input: ${error}`);
    },
  });
}

/**
 * Mutation hook for resizing execution terminal
 */
export function useResizeTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId, cols, rows }: { taskId: number; cols: number; rows: number }) => {
      return await api.resizeTerminal(taskId, cols, rows);
    },
    onError: (error) => {
      toast.error(`Failed to resize terminal: ${error}`);
    },
  });
}

/**
 * Unified agent discovery hook — works for both local and remote connections.
 * connectionId = null → local maestro-server
 * connectionId = number → remote SSH connection
 * 5-minute staleTime mirrors backend TTL.
 */
export function useAgentDiscoveryQuery(
  connectionId: number | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["agentDiscovery", connectionId],
    queryFn: () => api.discoverAgents(connectionId),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Mutation hook for spawning an ACP session for a given agent and worktree path.
 * On success, invalidates all execution queries so the sidebar refreshes immediately.
 * On error, shows a toast via sonner (consistent with other mutation hooks).
 */
export function useSpawnAcpSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      cwd,
      sessionName,
      projectId,
      connectionId,
      worktreeBranch,
    }: {
      agentId: string;
      cwd: string;
      sessionName: string | null;
      projectId: number;
      connectionId: number | null;
      worktreeBranch?: string | null;
    }) => {
      return await api.spawnAcpSession(agentId, cwd, sessionName, projectId, connectionId, worktreeBranch ?? null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.all });
    },
    onError: (error) => {
      toast.error(`Failed to spawn ACP session: ${error}`);
    },
  });
}

/**
 * Query hook for fetching structured output from a completed ACP session.
 * Only enabled when logId is provided (dead session view).
 * staleTime Infinity: dead sessions never change once completed.
 */
export function useStructuredOutputQuery(logId: number | null) {
  return useQuery({
    queryKey: executionQueryKeys.structuredOutput(logId ?? 0),
    queryFn: () => api.getStructuredOutput(logId!),
    enabled: logId != null,
    staleTime: Infinity,
  });
}
