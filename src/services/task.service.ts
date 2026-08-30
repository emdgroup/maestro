import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";

import { commands } from "@/types/bindings";
import type {
  Task,
  TaskConfigRequest,
  TaskRelationship,
  TaskInstruction,
  RemoteIssue,
  TaskAttachment,
  CreateTaskRequest,
  UpdateTaskRequest,
  AgentRole,
  MergeResult,
} from "@/types/bindings";

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
  comments: (taskId: number) => [...taskQueryKeys.base, "comments", taskId] as const,
  attachments: (taskId: number) => [...taskQueryKeys.base, "attachments", taskId] as const,
  commitMessage: (taskId: number) => [...taskQueryKeys.base, "commitMessage", taskId] as const,
  proxyImage: (projectId: number, filePath: string) =>
    [...taskQueryKeys.base, "proxyImage", projectId, filePath] as const,
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
 * Mutation hook for creating a new task
 */
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateTaskRequest) => api.createTask(request),
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
    mutationFn: ({ taskId, updates }: { taskId: number; updates: Partial<Task> }) => {
      const request: UpdateTaskRequest = {
        status: updates.status ?? null,
        description: updates.description ?? null,
        title: updates.title ?? null,
        priority: updates.priority ?? null,
        base_branch: updates.base_branch ?? null,
        skills: updates.skills ?? null,
        agent_id: updates.agent_id ?? null,
        labels: updates.labels ?? null,
        auto_approve: updates.auto_approve ?? null,
        workspace_mode: updates.workspace_mode ?? null,
        workspace_worktree_id: updates.workspace_worktree_id ?? null,
        workspace_branch_mode: updates.workspace_branch_mode ?? null,
        workspace_branch: updates.workspace_branch ?? null,
      };
      return api.updateTask(taskId, request);
    },
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
/**
 * Mutation hook for choosing which agent profile a task uses for each role.
 *
 * Separate from `useUpdateTaskSettingsMutation` for the same reason the command is separate from
 * `update_task_settings`: that one rewrites every override column it names, so a caller wanting to
 * change one field has to resend the others correctly or silently clear them.
 */
export function useSetTaskProfileOverridesMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, overrides }: { taskId: number; overrides: Record<string, string> }) =>
      api.setTaskProfileOverrides(taskId, overrides),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to save the agents for this task"),
  });
}

export function useUpdateTaskSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, config }: { taskId: number; config: TaskConfigRequest }) =>
      api.updateTaskSettings(taskId, config),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.settingsByTask(variables.taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.lists(),
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
export function useResolveCommitMessageQuery(taskId: number, enabled: boolean) {
  return useQuery({
    queryKey: taskQueryKeys.commitMessage(taskId),
    queryFn: () => api.resolveCommitMessage(taskId),
    enabled,
    staleTime: 0,
  });
}

export function useApproveTaskAndMergeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      mergeStrategy,
      includeUntracked,
      commitMessage,
    }: {
      taskId: number;
      mergeStrategy: string;
      includeUntracked: boolean;
      commitMessage: string;
    }) => api.approveTaskAndMerge(taskId, mergeStrategy, includeUntracked, commitMessage),
    onSuccess: (result: unknown) => {
      const data = result as MergeResult;
      if (data.success) {
        // "Merge complete" was told to every approve path, including the three that do not
        // merge — commit-only, push, and the pull request that leaves the task in Review.
        if (data.pull_request_url) {
          toast.success("Pull request opened. The task stays in Review until it merges.");
        } else if (data.task_status === "Done") {
          toast.success("Task moved to Done.");
        } else {
          toast.success("Task approved.");
        }
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
 * Mutation hook for rejecting a review, either sending the task back to Planning
 * ("SendToBacklog") or cancelling it outright ("CancelTask")
 */
export function useRejectReviewMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, action }: { taskId: number; action: string }) =>
      api.rejectReview(taskId, action),
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
    queryFn: () => api.listTaskRelationships(taskId!),
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
 * Mutation hook for deleting a task relationship
 */
export function useDeleteTaskRelationshipMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ relationshipId }: { relationshipId: number; taskId: number }) =>
      api.deleteTaskRelationship(relationshipId),
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
    queryFn: () => api.listTaskInstructions(taskId!),
    enabled: taskId !== null,
  });
}

/**
 * Query hook for listing git branches of a project
 * Returns [BranchList, currentBranch] tuple where BranchList has local and remote arrays
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

export const issueTrackingQueryKeys = {
  remoteIssues: (projectId: number) => ["issue_tracking", "remote-issues", projectId] as const,
};

/**
 * Fetches remote issues from the connected issue tracking provider.
 * Only runs while the modal is open (enabled: isModalOpen).
 * Automatically refetches every 5 minutes while open; stops when closed.
 */
export function useListRemoteIssuesQuery(projectId: number | null, isModalOpen: boolean) {
  return useQuery({
    queryKey: issueTrackingQueryKeys.remoteIssues(projectId!),
    queryFn: () => api.listRemoteIssues(projectId!),
    enabled: isModalOpen && projectId !== null,
    staleTime: 60_000,
    refetchInterval: isModalOpen ? 5 * 60 * 1000 : false,
    retry: 1,
  });
}

/**
 * Batch-imports a list of RemoteIssues as Backlog tasks for the given project.
 * Skips any that have already been imported (handled by Rust).
 * Invalidates task list cache on success.
 */
export function useImportTasksMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      issues,
      baseBranch,
    }: {
      projectId: number;
      issues: RemoteIssue[];
      baseBranch: string;
    }) => api.importTasks(projectId, issues, baseBranch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to import tasks"),
  });
}

/**
 * Overwrites a task's title, description, labels, and external_updated_at
 * from the current remote issue data. This is the "Update task" action in the Changed tab.
 */
export function useUpdateTaskFromRemoteMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, issue }: { taskId: number; issue: RemoteIssue }) =>
      api.updateTaskFromRemote(taskId, issue),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to update task from remote"),
  });
}

/**
 * Advances a task's external_updated_at to the remote value, clearing the
 * "changed" flag without modifying task content. This is the "Dismiss change" action.
 */
export function useDismissTaskChangeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, remoteUpdatedAt }: { taskId: number; remoteUpdatedAt: string }) =>
      api.dismissTaskChange(taskId, remoteUpdatedAt),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to dismiss task change"),
  });
}

/**
 * Query hook for fetching attachments for a task
 */
export function useTaskAttachmentsQuery(taskId: number | null) {
  return useQuery<TaskAttachment[]>({
    queryKey: taskQueryKeys.attachments(taskId!),
    queryFn: () => api.listTaskAttachments(taskId!),
    enabled: taskId !== null,
  });
}

/**
 * Mutation hook for adding an attachment record to a task
 */
export function useAddTaskAttachmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      filename,
      filePath,
    }: {
      taskId: number;
      filename: string;
      filePath: string;
    }) => api.addTaskAttachment(taskId, filename, filePath),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.attachments(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to add attachment"),
  });
}

/**
 * Mutation hook for deleting an attachment record from a task
 */
export function useDeleteTaskAttachmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ attachmentId }: { attachmentId: number; taskId: number }) =>
      api.deleteTaskAttachment(attachmentId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.attachments(variables.taskId),
      });
    },
    onError: createErrorToastHandler("Failed to remove attachment"),
  });
}

/**
 * Mutation hook for interrupting the active session for a task and returning it to Backlog
 */
export function useInterruptTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.interruptTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to interrupt task"),
  });
}

/**
 * Mutation hook for moving a task to review by hand.
 *
 * The escape hatch for when neither completion signal fires — the agent ignored the marker and
 * changed nothing, so the automatic rules left it in progress.
 *
 * Resolves to `null` when the task changed nothing and `force` was not set; the caller is expected
 * to confirm and retry with `force`, rather than silently opening a review with an empty diff.
 */
export function useSendTaskToReviewMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, force = false }: { taskId: number; force?: boolean }) =>
      api.sendTaskToReview(taskId, force),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to send task to review"),
  });
}

/**
 * The task's outcome thread, oldest entry first.
 *
 * Refetches on `task-comments-changed`, which the backend emits when a phase records its closing
 * message — otherwise a thread left open while an agent finishes would stay blank.
 */
export function useTaskCommentsQuery(taskId: number | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (taskId === undefined) return;
    const unlisten = listen<number>("task-comments-changed", (event) => {
      if (event.payload === taskId) {
        void queryClient.invalidateQueries({ queryKey: taskQueryKeys.comments(taskId) });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [taskId, queryClient]);

  return useQuery({
    queryKey: taskQueryKeys.comments(taskId ?? -1),
    queryFn: () => api.listTaskComments(taskId!),
    enabled: taskId !== undefined,
  });
}

/**
 * Mutation hook for adding a note of the user's own to a task's thread.
 *
 * Only notes are writable from the UI — the typed kinds are the pipeline's record of what an agent
 * concluded, and a hand-written one would make a gate's evidence forgeable.
 */
export function useAddTaskNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: number; body: string }) =>
      api.addTaskNote(taskId, body),
    onSuccess: (_data, { taskId }) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.comments(taskId) });
    },
    onError: createErrorToastHandler("Failed to add the note"),
  });
}

/**
 * Mutation hook for claiming a task before its session is spawned.
 *
 * Not `updateTask({ status: "InProgress" })` — that is a manual move, which parks the task with
 * no phase and the ball on nobody, so the card looks idle for the whole run.
 *
 * Resolves to null when the task cannot be claimed, which the caller must treat as a refusal to
 * start rather than an error.
 */
export function useMarkTaskExecutionStartedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.markTaskExecutionStarted(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to mark task as started"),
  });
}

/**
 * Mutation hook for moving a claimed task to In Progress once its session is live.
 *
 * Resolves to null when the task is no longer the one that was claimed.
 */
export function useMarkTaskSessionReadyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, role }: { taskId: number; role: AgentRole }) =>
      api.markTaskSessionReady(taskId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to mark the session as ready"),
  });
}

/**
 * Mutation hook for handing back a claim whose spawn never produced a session.
 *
 * `failed` decides what the user sees: true leaves the card red so a spawn error is visible and
 * retryable, false simply parks the task again because cancelling is not a failure.
 */
export function useReleaseTaskExecutionClaimMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, failed }: { taskId: number; failed: boolean }) =>
      api.releaseTaskExecutionClaim(taskId, failed),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to release the execution claim"),
  });
}

/**
 * Answers the refiner's proposal gate.
 *
 * Accepting is the first and only moment the description changes — the refiner writes nothing
 * itself — so rejecting needs no undo.
 */
export function useCloseRefinementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, accept }: { taskId: number; accept: boolean }) =>
      api.closeRefinement(taskId, accept),
    onSuccess: (_task, { accept }) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
      toast.success(accept ? "Description updated" : "Proposal discarded");
    },
    onError: createErrorToastHandler("Failed to close the refinement"),
  });
}

/**
 * Mutation hook for cancelling a task: sets status=Cancelled and archived_at atomically
 */
export function useCancelTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => api.cancelTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
      toast.success("Task cancelled");
    },
    onError: createErrorToastHandler("Failed to cancel task"),
  });
}

export function useProxyImageQuery(projectId: number, filePath: string) {
  return useQuery({
    queryKey: taskQueryKeys.proxyImage(projectId, filePath),
    queryFn: async () => {
      const result = await commands.proxyImage(projectId, filePath);
      if (result.status === "ok") return result.data;
      return null;
    },
    staleTime: Infinity,
  });
}
