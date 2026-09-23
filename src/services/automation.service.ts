import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { executionQueryKeys } from "@/services/execution.service";
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

/**
 * When a schedule being written would next fire.
 *
 * Asked of the server while the user edits, because the daemon is the only thing that parses cron
 * and it is also the thing that decides when a run happens. Held for the session: an expression
 * and a zone give the same answer every time within a minute of each other, and the editor asks
 * again for every keystroke that changes either.
 */
export function usePreviewScheduleQuery(
  projectId: number | null,
  cron: string | null,
  timezone: string,
) {
  return useQuery({
    queryKey: [...automationQueryKeys.base, "preview", projectId, cron, timezone] as const,
    queryFn: () => api.previewSchedule(projectId!, cron!, timezone),
    enabled: projectId != null && cron != null && cron.trim().length > 0,
    staleTime: 30_000,
    retry: false,
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

      // The server announces a run again once its session is live. Opening a project adopts what
      // is already running, but nothing else would take over one started while this window was
      // open, and its output and its questions would have nowhere to go.
      if (run.status === "running" && run.session_id) {
        void api
          .adoptAutomationSession(projectId, run.session_id)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: executionQueryKeys.activeSessions(projectId),
            }),
          )
          .catch((error: unknown) => console.warn("could not take over an automation run", error));
      }

      // An agent starting on its own is worth saying out loud, even on a tab where the row is not
      // visible. Only the scheduled ones: somebody who pressed Run now is already looking at it.
      // Said on the second announcement, once there is a session, so it is said once and can
      // always offer the way in.
      if (run.scheduled && run.status === "running" && run.session_id) {
        const sessionId = run.session_id;
        toast.info(`“${run.automation_name}” started`, {
          description: "Started by its schedule.",
          action: {
            label: "Open session",
            onClick: () => useNavigationStore.getState().navigate({ sessionId }),
          },
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
