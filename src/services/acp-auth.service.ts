import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { ConnectionKey } from "@/types/bindings";

export const authQueryKeys = {
  base: ["agentAuth"] as const,
  info: (agentId: string | null, connection: ConnectionKey) =>
    [...authQueryKeys.base, "info", agentId, connection] as const,
};

export function useAgentAuthInfoQuery(agentId: string | null, connection: ConnectionKey) {
  return useQuery({
    queryKey: authQueryKeys.info(agentId, connection),
    queryFn: () => api.getAgentAuthInfo(agentId!, connection),
    enabled: !!agentId,
    staleTime: 30_000,
  });
}

/**
 * The interactive terminal a `terminal` auth method signs in through. Imperative and uncached, so
 * plain functions. Input and abort are fire-and-forget: a terminal that is already gone has nothing
 * to report.
 */
export const startAuthTerminal = (
  agentId: string,
  methodId: string,
  connection: ConnectionKey,
  sessionId: string,
) => api.acpStartAuthTerminal(agentId, methodId, connection, sessionId);

export function abortAuthTerminal(connection: ConnectionKey) {
  void api.acpAbortAuthTerminal(connection).catch(() => {});
}

export function sendAuthTerminalInput(connection: ConnectionKey, data: string) {
  void api
    .acpSendAuthPtyInput(connection, Array.from(new TextEncoder().encode(data)))
    .catch(() => {});
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
    onError: createErrorToastHandler("Failed to sign out"),
  });
}
