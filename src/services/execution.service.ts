import { useQuery, useMutation } from "@tanstack/react-query";
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
 * Fire-and-forget side effect operation
 */
export function useSpawnExecutionMutation() {
  return useMutation({
    mutationFn: async ({
      projectId,
      taskId,
      repoPath,
    }: {
      projectId: number;
      taskId: number;
      repoPath: string;
    }) => {
      return await api.spawnAgentExecution(projectId, taskId, repoPath);
    },
    onError: (error) => {
      toast.error(`Failed to spawn execution: ${error}`);
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
