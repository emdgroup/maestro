import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/utils/helpers/tauri-utils";
import { toast } from "sonner";

import type {
  Task,
  TaskStatus,
  ExecutionLog,
  ProjectConfigResponse,
  ProjectConfigRequest,
} from "@/types";

/**
 * Query key factory for task-related queries
 * Ensures consistent cache invalidation across components
 */
const taskQueryKeys = {
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

/**
 * Query hook for fetching all tasks for a project
 */
export function useTasksQuery(projectId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => api.getTasks(projectId!),
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
    queryFn: () => api.getExecutionLogs(taskId!),
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
    queryFn: () => api.getTaskSettings(projectId!, taskId!),
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
    queryFn: () => api.getDiffForReview(taskId!),
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
    mutationFn: (request: Task) => api.createTask(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(
        `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      api.updateTask(taskId, updates),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(data.id) });
    },
    onError: (error) => {
      toast.error(
        `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      api.updateTaskStatus(taskId, status),
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
      toast.error(
        `Failed to update task status: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    mutationFn: (logId: number) => api.retryExecution(logId),
    onSuccess: (data: ExecutionLog) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.logsByTask(data.task_id) });
    },
    onError: (error) => {
      toast.error(
        `Failed to retry execution: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for canceling task execution
 */
export function useCancelExecutionMutation() {
  return useMutation({
    mutationFn: (logId: number) => api.cancelExecution(logId),
    onSuccess: () => {
      toast.success("Execution cancelled");
    },
    onError: (error) => {
      toast.error(
        `Failed to cancel execution: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    }) => api.updateTaskSettings(projectId, taskId, config),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: taskQueryKeys.settingsByTask(variables.projectId, variables.taskId),
      });
    },
    onError: (error) => {
      toast.error(
        `Failed to update task settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for saving task review
 */
export function useSaveTaskReviewMutation() {
  return useMutation({
    mutationFn: ({
      taskId,
      decision,
      generalFeedback,
      perFileComments,
    }: {
      taskId: number;
      decision: string;
      generalFeedback: string | null;
      perFileComments: Array<[string, string]> | null;
    }) => api.saveTaskReview(taskId, decision, generalFeedback, perFileComments),
    onError: (error) => {
      toast.error(
        `Failed to save review: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for approving task and starting merge
 */
export function useApproveTaskAndMergeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: number) => api.approveTaskAndMerge(taskId),
    onSuccess: () => {
      toast.success("Approval submitted. Merge starting...");
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(
        `Failed to approve task: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for requesting changes
 */
export function useRequestChangesMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      generalFeedback,
      perFileComments,
    }: {
      taskId: number;
      generalFeedback: string | null;
      perFileComments: Array<[string, string]> | null;
    }) => api.requestChanges(taskId, generalFeedback, perFileComments),
    onSuccess: () => {
      toast.info("Changes requested. Task returned to In Progress.");
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(
        `Failed to request changes: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
