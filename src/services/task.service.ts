import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, createErrorToastHandler } from "@/lib";
import { toast } from "sonner";

import type { Task, TaskConfigRequest, TaskRelationship, TaskInstruction } from "@/types/bindings";

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
  relationships: (taskId: number) => [...taskQueryKeys.all, "relationships", taskId] as const,
  instructions: (taskId: number) => [...taskQueryKeys.all, "instructions", taskId] as const,
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
    refetchInterval: 3000, // Poll every 3 seconds for task updates
    refetchIntervalInBackground: false, // Don't poll when app is in background
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
    refetchInterval: 5000, // Poll every 5 seconds for log updates
    refetchIntervalInBackground: false, // Don't poll when app is in background
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
 * Mutation hook for approving task and performing synchronous merge
 */
export function useApproveTaskAndMergeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, mergeStrategy }: { taskId: number; mergeStrategy: string }) =>
      api.approveTaskAndMerge(taskId, mergeStrategy),
    onSuccess: (result: unknown) => {
      const data = result as { success: boolean; task_status: string; conflicts?: string[] };
      if (data.success) {
        toast.success("Merge complete. Task moved to Done.");
      } else {
        toast.error(
          `Merge conflict detected. Task returned to In Progress. Conflicts: ${(data.conflicts ?? []).join(", ")}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to approve task"),
  });
}

/**
 * Mutation hook for rejecting a review with one of three actions:
 * SendToBacklog, ResumeWithInstructions, CancelTask
 */
export function useRejectReviewMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      action,
      instruction,
    }: {
      taskId: number;
      action: string;
      instruction?: string;
    }) => api.rejectReview(taskId, action, instruction ?? null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to reject review"),
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

/**
 * Mutation hook for archiving a task (sets archived_at timestamp)
 */
export function useArchiveTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.archiveTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks", "list"] });
      toast.success("Task archived");
    },
    onError: createErrorToastHandler("Failed to archive task"),
  });
}

/**
 * Mutation hook for deleting a task
 */
export function useDeleteTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId: number) => api.deleteTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to delete task"),
  });
}

/**
 * Query hook for fetching task relationships
 */
export function useTaskRelationshipsQuery(taskId: number | null) {
  return useQuery<TaskRelationship[]>({
    queryKey: taskQueryKeys.relationships(taskId!),
    queryFn: () => api.getTaskRelationships(taskId!),
    enabled: taskId !== null,
  });
}

/**
 * Mutation hook for adding a task relationship
 */
export function useAddTaskRelationshipMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      fromTaskId,
      toTaskId,
      relationshipType,
    }: {
      fromTaskId: number;
      toTaskId: number;
      relationshipType: string;
    }) => api.addTaskRelationship(fromTaskId, toTaskId, relationshipType),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.relationships(variables.fromTaskId),
      });
    },
    onError: createErrorToastHandler("Failed to add relationship"),
  });
}

/**
 * Mutation hook for removing a task relationship
 */
export function useRemoveTaskRelationshipMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ relationshipId }: { relationshipId: number; taskId: number }) =>
      api.removeTaskRelationship(relationshipId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.relationships(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to remove relationship"),
  });
}

/**
 * Query hook for fetching task instructions log
 */
export function useTaskInstructionsQuery(taskId: number | null) {
  return useQuery<TaskInstruction[]>({
    queryKey: taskQueryKeys.instructions(taskId!),
    queryFn: () => api.getTaskInstructions(taskId!),
    enabled: taskId !== null,
  });
}

/**
 * Mutation hook for adding an instruction to a task
 */
export function useAddTaskInstructionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      content,
      source,
    }: {
      taskId: number;
      content: string;
      source: string;
    }) => api.addTaskInstruction(taskId, content, source),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.instructions(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to add instruction"),
  });
}
