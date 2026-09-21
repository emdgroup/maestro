import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { AutomationsDocument } from "@/types/bindings";

export const automationQueryKeys = {
  base: ["automations"] as const,
  list: (projectId: number) => [...automationQueryKeys.base, "list", projectId] as const,
};

/** The project's automations, as read from `.maestro/automations.json`. */
export function useAutomationsQuery(projectId: number | null) {
  return useQuery({
    queryKey: automationQueryKeys.list(projectId!),
    queryFn: () => api.listAutomations(projectId!),
    enabled: projectId != null,
  });
}

/**
 * Whole-document, matching the command: the Rust side validates ids across the whole set, which
 * cannot be checked one automation at a time.
 */
export function useSaveAutomationsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, document }: { projectId: number; document: AutomationsDocument }) =>
      api.saveAutomations(projectId, document),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.list(projectId) });
    },
    onError: createErrorToastHandler("Failed to save automations"),
  });
}
