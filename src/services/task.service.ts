import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "./ipc";
import type {
  Task,
  TaskStatus,
  CreateTaskRequest,
  ExecutionLog,
  ProjectConfigResponse,
  ProjectConfigRequest,
} from "@/types/bindings";

/**
 * Query key factory for task-related queries
 * Ensures consistent cache invalidation across components
 */
export const taskQueryKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskQueryKeys.all, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  details: () => [...taskQueryKeys.all, "detail"] as const,
  detail: (taskId: number) => [...taskQueryKeys.details(), taskId] as const,
  logs: () => [...taskQueryKeys.all, "logs"] as const,
  logsByTask: (taskId: number) => [...taskQueryKeys.logs(), { taskId }] as const,
  settings: () => [...taskQueryKeys.all, "settings"] as const,
  settingsByTask: (projectId: number, taskId: number) =>
    [...taskQueryKeys.settings(), { projectId, taskId }] as const,
};

/**
 * Task service providing type-safe operations for task management.
 * All task-related IPC calls are centralized here.
 */
export const taskService = {
  /**
   * Get all tasks for a project
   */
  async getTasks(projectId: number): Promise<Task[]> {
    return ipc.invoke<Task[]>("get_tasks", { projectId });
  },

  /**
   * Create a new task
   */
  async createTask(request: CreateTaskRequest): Promise<Task> {
    return ipc.invoke<Task>("create_task", { request });
  },

  /**
   * Update task status and other properties
   */
  async updateTask(taskId: number, updates: Partial<Task>): Promise<Task> {
    return ipc.invoke<Task>("update_task", { taskId, updates });
  },

  /**
   * Update task status (convenience method)
   */
  async updateTaskStatus(taskId: number, status: TaskStatus): Promise<Task> {
    return ipc.invoke<Task>("update_task_status", { taskId, status });
  },

  /**
   * Get execution logs for a task
   */
  async getExecutionLogs(taskId: number): Promise<ExecutionLog[]> {
    return ipc.invoke<ExecutionLog[]>("get_execution_logs", { taskId });
  },

  /**
   * Retry execution of a task
   */
  async retryExecution(logId: number): Promise<ExecutionLog> {
    return ipc.invoke<ExecutionLog>("retry_execution", { logId });
  },

  /**
   * Cancel execution of a task
   */
  async cancelExecution(logId: number): Promise<void> {
    return ipc.invoke<void>("cancel_execution", { logId });
  },

  /**
   * Get task settings/configuration
   */
  async getTaskSettings(projectId: number, taskId: number): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("get_project_settings", { projectId, taskId });
  },

  /**
   * Update task settings/configuration
   */
  async updateTaskSettings(
    projectId: number,
    taskId: number,
    config: ProjectConfigRequest
  ): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("update_task_settings", {
      projectId,
      taskId,
      config,
    });
  },

  /**
   * Get diff for review
   */
  async getDiffForReview(taskId: number): Promise<string> {
    return ipc.invoke<string>("get_diff_for_review", { taskId });
  },
};

/**
 * Query hook for fetching all tasks for a project
 */
export function useTasksQuery(projectId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => taskService.getTasks(projectId!),
    enabled: projectId !== null,
    staleTime: 30000, // 30 seconds—tasks change fairly frequently
    refetchOnWindowFocus: true,
  });
}

/**
 * Query hook for fetching execution logs for a task
 */
export function useExecutionLogsQuery(taskId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.logsByTask(taskId!),
    queryFn: () => taskService.getExecutionLogs(taskId!),
    enabled: taskId !== null,
    staleTime: 10000, // 10 seconds—logs update frequently
    refetchOnWindowFocus: true,
  });
}

/**
 * Query hook for fetching task settings/configuration
 */
export function useTaskSettingsQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.settingsByTask(projectId!, taskId!),
    queryFn: () => taskService.getTaskSettings(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
    staleTime: 60000, // 60 seconds—settings change rarely
  });
}

/**
 * Query hook for fetching diff for review (always fresh, no cache)
 */
export function useDiffForReviewQuery(taskId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.detail(taskId!),
    queryFn: () => taskService.getDiffForReview(taskId!),
    enabled: taskId !== null,
    staleTime: 0, // Always fetch fresh—diffs should reflect current state
  });
}

/**
 * Mutation hook for creating a new task
 */
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateTaskRequest) => taskService.createTask(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for updating task details
 */
export function useUpdateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, updates }: { taskId: number; updates: Partial<Task> }) =>
      taskService.updateTask(taskId, updates),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(data.id) });
    },
    onError: (error) => {
      toast.error(`Failed to update task: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for updating task status with optimistic updates
 */
export function useUpdateTaskStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, status }: { taskId: number; status: TaskStatus }) =>
      taskService.updateTaskStatus(taskId, status),
    onMutate: async ({ taskId, status }) => {
      // Cancel outgoing queries to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: taskQueryKeys.detail(taskId) });

      // Snapshot previous value for rollback
      const previousTask = queryClient.getQueryData<Task>(taskQueryKeys.detail(taskId));

      // Optimistically update cache
      queryClient.setQueryData<Task>(taskQueryKeys.detail(taskId), (old) => {
        if (!old) return old;
        return { ...old, status };
      });

      return { previousTask, taskId };
    },
    onError: (error, _variables, context) => {
      // Rollback on error
      if (context?.previousTask) {
        queryClient.setQueryData(taskQueryKeys.detail(context.taskId), context.previousTask);
      }
      toast.error(`Failed to update task status: ${error instanceof Error ? error.message : String(error)}`);
    },
    onSettled: (_data, _error, variables) => {
      // Always refetch to ensure cache is consistent
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(variables.taskId) });
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}

/**
 * Mutation hook for retrying task execution
 */
export function useRetryExecutionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (logId: number) => taskService.retryExecution(logId),
    onSuccess: (data: ExecutionLog) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.logsByTask(data.task_id) });
    },
    onError: (error) => {
      toast.error(`Failed to retry execution: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for canceling task execution
 */
export function useCancelExecutionMutation() {
  return useMutation({
    mutationFn: (logId: number) => taskService.cancelExecution(logId),
    onSuccess: () => {
      toast.success("Execution cancelled");
    },
    onError: (error) => {
      toast.error(`Failed to cancel execution: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for updating task settings
 */
export function useUpdateTaskSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      taskId,
      config,
    }: {
      projectId: number;
      taskId: number;
      config: ProjectConfigRequest;
    }) => taskService.updateTaskSettings(projectId, taskId, config),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskQueryKeys.settingsByTask(variables.projectId, variables.taskId),
      });
    },
    onError: (error) => {
      toast.error(`Failed to update task settings: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
