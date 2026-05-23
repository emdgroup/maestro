import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { IntegrationStatus, ProjectTicketingConfig } from "@/types/bindings";

export type { IntegrationStatus, ProjectTicketingConfig };

export const integrationQueryKeys = {
  base: ["integrations"] as const,
  list: () => [...integrationQueryKeys.base, "list"] as const,
  projectTicketing: (projectId: number) =>
    [...integrationQueryKeys.base, "ticketing", projectId] as const,
};

export function useListIntegrations() {
  return useQuery({
    queryKey: integrationQueryKeys.list(),
    queryFn: () => api.listIntegrations(),
    staleTime: 30_000,
  });
}

export function useSaveIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      token,
      instanceUrl,
      email,
    }: {
      provider: string;
      token: string;
      instanceUrl: string | null;
      email: string | null;
    }) => api.saveIntegration(provider, token, instanceUrl, email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
    },
    onError: createErrorToastHandler("Failed to connect integration"),
  });
}

export function useDeleteIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.deleteIntegration(provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
    },
    onError: createErrorToastHandler("Failed to disconnect integration"),
  });
}

export function useProjectTicketingConfig(projectId: number) {
  return useQuery({
    queryKey: integrationQueryKeys.projectTicketing(projectId),
    queryFn: () => api.getProjectTicketingConfig(projectId),
    staleTime: Infinity,
  });
}

export function useSaveProjectTicketingConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      ticketing,
    }: {
      projectId: number;
      ticketing: ProjectTicketingConfig | null;
    }) => api.saveProjectTicketingConfig(projectId, ticketing),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.projectTicketing(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to save ticketing config"),
  });
}
