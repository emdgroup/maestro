import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import type { ConnectionKey } from "@/types/bindings";

export const authQueryKeys = {
  info: (agentId: string, connection: ConnectionKey) =>
    ["agentAuthInfo", agentId, connection] as const,
};

export function useAgentAuthInfoQuery(agentId: string | null, connection: ConnectionKey) {
  return useQuery({
    queryKey: authQueryKeys.info(agentId ?? "", connection),
    queryFn: () => api.getAgentAuthInfo(agentId!, connection),
    enabled: !!agentId,
    staleTime: 30_000,
  });
}

export function useAcpAuthenticateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      methodId,
      connection,
    }: {
      agentId: string;
      methodId: string;
      connection: ConnectionKey;
    }) => api.acpAuthenticate(agentId, methodId, connection),
    onSuccess: (_, { agentId, connection }) => {
      void queryClient.invalidateQueries({ queryKey: authQueryKeys.info(agentId, connection) });
    },
  });
}

export function useAcpLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, connection }: { agentId: string; connection: ConnectionKey }) =>
      api.acpLogout(agentId, connection),
    onSuccess: (_, { agentId, connection }) => {
      void queryClient.invalidateQueries({ queryKey: authQueryKeys.info(agentId, connection) });
    },
  });
}
