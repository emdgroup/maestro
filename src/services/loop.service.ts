import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { taskQueryKeys } from "@/services/task.service";
import type { LoopCheckEntry, LoopCheckSpec, LoopHiddenFile, TaskStatus } from "@/types/bindings";

/**
 * A loop's own rows, kept beside the task's. Every write to them pushes `tasks-changed`, which
 * `useServerEventSync` turns into an invalidation of these kinds, so the queries need no listener.
 */
export const loopQueryKeys = {
  checks: (projectId: number, taskId: number) =>
    [...taskQueryKeys.base, "loopChecks", projectId, taskId] as const,
  iterations: (projectId: number, taskId: number) =>
    [...taskQueryKeys.base, "loopIterations", projectId, taskId] as const,
  hiddenFiles: (projectId: number, taskId: number) =>
    [...taskQueryKeys.base, "loopHiddenFiles", projectId, taskId] as const,
  notes: (projectId: number, taskId: number) =>
    [...taskQueryKeys.base, "loopNotes", projectId, taskId] as const,
};

/** The query kinds `tasks-changed` refetches for the open loop. */
export const LOOP_QUERY_KINDS = ["loopChecks", "loopIterations", "loopHiddenFiles", "loopNotes"];

type TaskKey = { projectId: number; taskId: number };

export function useLoopChecksQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.checks(projectId ?? -1, taskId ?? -1),
    queryFn: () => api.listLoopChecks(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

export function useLoopIterationsQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.iterations(projectId ?? -1, taskId ?? -1),
    queryFn: () => api.listLoopIterations(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

export function useLoopHiddenFilesQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.hiddenFiles(projectId ?? -1, taskId ?? -1),
    queryFn: () => api.listLoopHiddenFiles(projectId!, taskId!),
    enabled: projectId !== null && taskId !== null,
  });
}

/** `.maestro/loop/PROGRESS.md` in the loop's worktree; `null` while there is none. */
export function useLoopNotesQuery(projectId: number | null, taskId: number | null) {
  return useQuery({
    queryKey: loopQueryKeys.notes(projectId ?? -1, taskId ?? -1),
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
      for (const kind of LOOP_QUERY_KINDS) {
        void queryClient.invalidateQueries({
          queryKey: [...taskQueryKeys.base, kind, projectId, taskId],
        });
      }
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

export function useSetLoopHiddenFilesMutation() {
  return useLoopMutation(
    ({ projectId, taskId, files }: TaskKey & { files: LoopHiddenFile[] }) =>
      api.setLoopHiddenFiles(projectId, taskId, files),
    "Failed to save the hidden files",
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

/** Start a loop over from scratch in Planning or Queue: its branch reset, its history gone. */
export function useRestartLoopMutation() {
  return useLoopMutation(
    ({ projectId, taskId, status }: TaskKey & { status: TaskStatus }) =>
      api.restartLoop(projectId, taskId, status),
    "Failed to restart the loop",
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

/** Which of `candidates`, paths a check command names, are committed on `branch` and can be sealed. */
export function sealablePaths(
  projectId: number,
  branch: string,
  candidates: string[],
): Promise<string[]> {
  return api.loopSealablePaths(projectId, branch, candidates);
}

/** Which of a loop's sealed paths are committed on `branch`, where its checks will find them. */
export function useSealablePathsQuery(projectId: number, branch: string, paths: string[]) {
  return useQuery({
    queryKey: [...taskQueryKeys.base, "loopSealable", projectId, branch, paths] as const,
    queryFn: () => sealablePaths(projectId, branch, paths),
    enabled: paths.length > 0 && branch !== "",
  });
}
