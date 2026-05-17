import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";

import type { Task, TaskConfigRequest, TaskRelationship, TaskInstruction } from "@/types/bindings";

/**
 * Query key factory for task-related queries
 * Ensures consistent cache invalidation across components
 */
export const taskQueryKeys = {
  base: ["tasks"] as const,
  lists: () => [...taskQueryKeys.base, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  details: () => [...taskQueryKeys.base, "detail"] as const,
  detail: (taskId: number) => [...taskQueryKeys.details(), taskId] as const,
  logs: () => [...taskQueryKeys.base, "logs"] as const,
  logsByTask: (taskId: number) => [...taskQueryKeys.logs(), { taskId }] as const,
  settings: () => [...taskQueryKeys.base, "settings"] as const,
  settingsByTask: (taskId: number) => [...taskQueryKeys.settings(), taskId] as const,
  relationships: (taskId: number) => [...taskQueryKeys.base, "relationships", taskId] as const,
  instructions: (taskId: number) => [...taskQueryKeys.base, "instructions", taskId] as const,
};

/**
 * Task service providing type-safe operations for task management.
 * All task-related IPC calls are centralized here.
 */

/**
 * Event-driven task list. Refreshes on "tasks-changed" Tauri event.
 */
export function useTasksQuery(projectId: number | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("tasks-changed", () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => api.getTasks(projectId!),
    enabled: projectId !== null,
    staleTime: 30000,
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
        request.base_branch,
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
      api.updateTask(
        taskId,
        updates.status ?? null,
        updates.description ?? null,
        updates.name ?? null,
        updates.priority ?? null,
        updates.acceptance_criteria ?? null,
        updates.base_branch ?? null,
        updates.skills ?? null,
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(data.id) });
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to update task"),
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
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
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
 * Query hook for listing git branches of a project
 * Returns [branches, currentBranch] tuple
 */
export function useProjectBranchesQuery(projectId: number | null) {
  return useQuery({
    queryKey: [...taskQueryKeys.base, "branches", projectId],
    queryFn: () => api.listProjectBranches(projectId!),
    enabled: projectId !== null,
    staleTime: 60000, // 1 minute — branches don't change that often
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
