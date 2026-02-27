import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "./ipc";

/**
 * Execution service providing type-safe operations for task execution and terminal management.
 * All execution and terminal-related IPC calls are centralized here.
 */
export const executionService = {
  /**
   * Spawn agent execution for a task
   */
  async spawnAgentExecution(projectId: number, taskId: number, repoPath: string): Promise<number> {
    return ipc.invoke<number>("spawn_agent_execution", {
      project_id: projectId,
      task_id: taskId,
      repo_path: repoPath,
    });
  },

  /**
   * Pause agent execution for a task
   */
  async pauseAgentExecution(taskId: number): Promise<void> {
    return ipc.invoke<void>("pause_agent_execution", { taskId });
  },

  /**
   * Resume agent execution for a task
   */
  async resumeAgentExecution(taskId: number, projectId: number, repoPath: string): Promise<number> {
    return ipc.invoke<number>("resume_agent_execution", {
      taskId,
      projectId,
      repoPath,
    });
  },

  /**
   * Attach to a task's execution terminal
   */
  async attachTerminal(taskId: number, outputChannel: string): Promise<void> {
    return ipc.invoke<void>("attach_terminal", { taskId, outputChannel });
  },

  /**
   * Send input to a task's execution terminal
   */
  async sendTerminalInput(taskId: number, input: string): Promise<void> {
    return ipc.invoke<void>("send_terminal_input", { taskId, input });
  },

  /**
   * Resize execution terminal
   */
  async resizeTerminal(taskId: number, cols: number, rows: number): Promise<void> {
    return ipc.invoke<void>("resize_terminal", { taskId, cols, rows });
  },

  /**
   * Detach from a task's execution terminal
   */
  async detachTerminal(taskId: number): Promise<void> {
    return ipc.invoke<void>("detach_terminal", { taskId });
  },
};

/**
 * Query key factory for execution operations
 * Execution operations are primarily side-effects; included for consistency
 */
export const executionQueryKeys = {
  all: ["executions"] as const,
  details: () => [...executionQueryKeys.all, "detail"] as const,
  detail: (executionId: number) => [...executionQueryKeys.details(), executionId] as const,
};

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
      return await executionService.spawnAgentExecution(projectId, taskId, repoPath);
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
      return await executionService.pauseAgentExecution(taskId);
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
      return await executionService.resumeAgentExecution(taskId, projectId, repoPath);
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
    mutationFn: async ({ taskId, outputChannel }: { taskId: number; outputChannel: string }) => {
      return await executionService.attachTerminal(taskId, outputChannel);
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
      return await executionService.detachTerminal(taskId);
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
      return await executionService.sendTerminalInput(taskId, input);
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
      return await executionService.resizeTerminal(taskId, cols, rows);
    },
    onError: (error) => {
      toast.error(`Failed to resize terminal: ${error}`);
    },
  });
}
