import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { taskQueryKeys } from "@/services/task.service";
import type { LoopCheckEntry, LoopCheckSpec } from "@/types/bindings";

/**
 * A loop's own rows, kept beside the task's. Every write to them pushes `tasks-changed`, which
 * `useServerEventSync` turns into an invalidation of these kinds, so the queries need no listener.
 */
export const loopQueryKeys = {
  /** Under the task keys, so whatever refreshes a whole task's state refreshes its loop too. */
  base: [...taskQueryKeys.base, "loop"] as const,
  /** All three of a task's loop rows; `[...base, projectId]` is every loop in a project. */
  task: (projectId: number | null, taskId: number | null) =>
    [...loopQueryKeys.base, projectId, taskId] as const,
  checks: (projectId: number | null, taskId: number | null) =>
    [...loopQueryKeys.task(projectId, taskId), "checks"] as const,
  iterations: (projectId: number | null, taskId: number | null) =>
    [...loopQueryKeys.task(projectId, taskId), "iterations"] as const,
  notes: (projectId: number | null, taskId: number | null) =>
    [...loopQueryKeys.task(projectId, taskId), "notes"] as const,
  /** Outside `base`: a loop row changing says nothing about what is committed on a branch. */
  branchFiles: (projectId: number, branch: string) =>
    [...taskQueryKeys.base, "loopBranchFiles", projectId, branch] as const,
};

type TaskKey = { projectId: number; taskId: number };

export function useLoopChecksQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.checks(projectId, taskId),
    queryFn: () => api.listLoopChecks(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

export function useLoopIterationsQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.iterations(projectId, taskId),
    queryFn: () => api.listLoopIterations(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

/** `.maestro/loop/PROGRESS.md` in the loop's worktree; `null` while there is none. */
export function useLoopNotesQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.notes(projectId, taskId),
    queryFn: () => api.readLoopNotes(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

/** A loop write: the board and the loop's own rows are read again once it lands. */
function useLoopMutation<V extends TaskKey, R>(run: (vars: V) => Promise<R>, failure: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (_data, { projectId, taskId }) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: loopQueryKeys.task(projectId, taskId) });
    },
    onError: createErrorToastHandler(failure),
  });
}

export function useSetLoopChecksMutation() {
  return useLoopMutation(
    ({ projectId, taskId, checks }: TaskKey & { checks: LoopCheckEntry[] }) =>
      api.setLoopChecks(projectId, taskId, checks),
    "Failed to save the checks",
  );
}

export function useAnswerLoopProposalMutation() {
  return useLoopMutation(
    ({
      projectId,
      taskId,
      checkId,
      accept,
      seal,
    }: TaskKey & { checkId: number; accept: LoopCheckSpec | null; seal: string[] }) =>
      api.answerLoopProposal(projectId, taskId, checkId, accept, seal),
    "Failed to answer the proposal",
  );
}

export function useTickLoopCheckMutation() {
  return useLoopMutation(
    ({ projectId, taskId, checkId, ticked }: TaskKey & { checkId: number; ticked: boolean }) =>
      api.tickLoopCheck(projectId, taskId, checkId, ticked),
    "Failed to mark the check",
  );
}

export function useRerunLoopChecksMutation() {
  return useLoopMutation(
    ({ projectId, taskId }: TaskKey) => api.rerunLoopChecks(projectId, taskId),
    "Failed to re-run the checks",
  );
}

export function usePauseLoopMutation() {
  return useLoopMutation(
    ({ projectId, taskId }: TaskKey) => api.pauseLoop(projectId, taskId),
    "Failed to pause the loop",
  );
}

export function useStopLoopMutation() {
  return useLoopMutation(
    ({ projectId, taskId }: TaskKey) => api.stopLoop(projectId, taskId),
    "Failed to stop the loop",
  );
}

/** A note for the next iteration. The one running is not interrupted. */
export function useAddLoopNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, taskId, body }: TaskKey & { body: string }) =>
      api.addLoopNote(projectId, taskId, body),
    onSuccess: (_data, { projectId, taskId }) => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.comments(projectId, taskId) });
    },
    onError: createErrorToastHandler("Failed to add the note"),
  });
}

/** Let a stopped loop, or one at sign-off, go on, with an optional note for its next iteration. */
export function useResumeLoopMutation() {
  return useLoopMutation(
    ({ projectId, taskId, note }: TaskKey & { note: string | null }) =>
      api.resumeLoop(projectId, taskId, note),
    "Failed to resume the loop",
  );
}

/** Try now: open the agent's usage-limit gate so its waiting tasks start. */
export function useOpenAgentGateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, agentId }: { projectId: number; agentId: string }) =>
      api.openAgentGate(projectId, agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to try again"),
  });
}

/** Every file committed on `branch`, the project's HEAD when blank: what the agent's copy holds. */
export function useLoopBranchFilesQuery(projectId: number, branch: string) {
  return useQuery({
    queryKey: loopQueryKeys.branchFiles(projectId, branch),
    queryFn: () => api.loopBranchFiles(projectId, branch || null),
  });
}
