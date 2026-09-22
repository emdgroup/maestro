import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { useNavigationStore } from "@/store/navigationStore";
import type { Automation, AutomationRun } from "@/types/bindings";

export const automationQueryKeys = {
  base: ["automations"] as const,
  list: (projectId: number) => [...automationQueryKeys.base, "list", projectId] as const,
  runs: (projectId: number) => [...automationQueryKeys.base, "runs", projectId] as const,
};

/**
 * The project's automations, as the background server holds them.
 *
 * Each carries `next_due_at`, worked out server-side: the clock that fires them is over there, so
 * nothing here parses a cron expression to say when one is next due.
 */
export function useAutomationsQuery(projectId: number | null) {
  return useQuery({
    queryKey: automationQueryKeys.list(projectId!),
    queryFn: () => api.listAutomations(projectId!),
    enabled: projectId != null,
    // The list is only stale in one way that matters — `next_due_at` moves past — and a run
    // arriving invalidates it anyway.
    staleTime: 60_000,
  });
}

/** What this project's automations have done, newest first. */
export function useAutomationRunsQuery(projectId: number | null) {
  return useQuery({
    queryKey: automationQueryKeys.runs(projectId!),
    queryFn: () => api.listAutomationRuns(projectId!, null),
    enabled: projectId != null,
  });
}

/**
 * Keep the run list current while this window is attached.
 *
 * Runs start without anyone here asking: the clock fires them in the background server, which
 * announces each one as it opens and closes. Listing on mount is what catches the ones that
 * happened while Maestro was shut.
 */
export function useAutomationRunEvents(projectId: number | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (projectId == null) return;
    const unlisten = listen<AutomationRun>("automation-run-changed", ({ payload: run }) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.runs(projectId) });
      // A finished run moves the next occurrence along with it.
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.list(projectId) });

      // An agent starting on its own is worth saying out loud, even on a tab where the row is not
      // visible. Only the scheduled ones: somebody who pressed Run now is already looking at it.
      if (run.scheduled && run.status === "running") {
        toast.info(`“${run.automation_name}” started`, {
          description: "Started by its schedule.",
          action: run.session_id
            ? {
                label: "Open session",
                onClick: () =>
                  useNavigationStore.getState().navigate({ sessionId: run.session_id! }),
              }
            : undefined,
        });
      }
      if (run.status === "failed" && run.error) {
        toast.error(`“${run.automation_name}” did not finish`, { description: run.error });
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [projectId, queryClient]);
}

/** Create or replace one automation. One row at a time, which is how the server stores them. */
export function useSaveAutomationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, automation }: { projectId: number; automation: Automation }) =>
      api.saveAutomation(projectId, automation),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.list(projectId) });
    },
    onError: createErrorToastHandler("Failed to save the automation"),
  });
}

export function useDeleteAutomationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, automationId }: { projectId: number; automationId: string }) =>
      api.deleteAutomation(projectId, automationId),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.list(projectId) });
    },
    onError: createErrorToastHandler("Failed to delete the automation"),
  });
}

/**
 * Start one now.
 *
 * Nothing is returned but acceptance: the run announces itself on `automation-run-changed`, the
 * same way a scheduled one does, so there is only ever one path a run appears through.
 */
export function useRunAutomationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, automationId }: { projectId: number; automationId: string }) =>
      api.runAutomation(projectId, automationId),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.runs(projectId) });
    },
    onError: createErrorToastHandler("Failed to start the automation"),
  });
}
