import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, createErrorToastHandler } from "@/lib";
import { toast } from "sonner";

import type { Task, TaskConfigRequest } from "@/types";

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
  settingsByTask: (taskId: number) => [...taskQueryKeys.settings(), taskId] as const,
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
    mutationFn: (request: Task) =>
      api.createTask(
        request.project_id,
        request.name,
        request.description,
        request.acceptance_criteria || "",
        request.skills,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to create task"),
  });
}

/**
 * Mutation hook for updating task details
 */
export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, updates }: { taskId: number; updates: Partial<Task> }) =>
      api.updateTask(taskId, updates.status || null, updates.description || null),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(data.id) });
    },
    onError: createErrorToastHandler("Failed to update task"),
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
    onError: createErrorToastHandler("Failed to cancel execution"),
  });
}

/**
 * Mutation hook for updating task settings
 */
export function useUpdateTaskSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, config }: { taskId: number; config: TaskConfigRequest }) =>
      api.updateTaskSettings(taskId, config),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.settingsByTask(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to update task settings"),
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
    onError: createErrorToastHandler("Failed to save review"),
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
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to approve task"),
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
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to request changes"),
  });
}
