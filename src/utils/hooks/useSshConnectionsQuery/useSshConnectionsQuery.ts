import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { SshConnection } from "@/types/bindings";

export const SSH_CONNECTIONS_KEY = ["ssh-connections"];

/**
 * Query hook for fetching SSH connections from database
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnectionsQuery() {
  return useQuery({
    queryKey: SSH_CONNECTIONS_KEY,
    queryFn: async () => {
      return await invoke<SshConnection[]>("get_ssh_connections", {});
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
    refetchOnWindowFocus: true, // Auto-refetch when user returns to tab
  });
}

/**
 * Mutation hook for updating SSH connection display name
 * Uses optimistic updates for instant UI feedback
 */
export function useUpdateSshConnectionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      connectionId,
      displayName,
    }: {
      connectionId: number;
      displayName: string;
    }) => {
      await invoke("rename_ssh_connection", {
        connectionId,
        displayName,
      });
    },
    onMutate: async ({ connectionId, displayName }) => {
      // Cancel any outgoing refetches to prevent overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: SSH_CONNECTIONS_KEY });

      // Snapshot the previous value for rollback on error
      const previousConnections = queryClient.getQueryData<SshConnection[]>(SSH_CONNECTIONS_KEY);

      // Optimistically update the cache
      queryClient.setQueryData<SshConnection[]>(SSH_CONNECTIONS_KEY, (old) => {
        if (!old) return old;
        return old.map((conn) =>
          conn.id === connectionId ? { ...conn, display_name: displayName } : conn
        );
      });

      // Return context with snapshot for potential rollback
      return { previousConnections };
    },
    onError: (error, _variables, context) => {
      // Rollback to previous state on error
      if (context?.previousConnections) {
        queryClient.setQueryData(SSH_CONNECTIONS_KEY, context.previousConnections);
      }
      toast.error(`Failed to rename connection: ${error}`);
    },
    onSuccess: () => {
      toast.success("Connection renamed successfully");
    },
    onSettled: async () => {
      // Always refetch after mutation to ensure cache is in sync with server
      await queryClient.invalidateQueries({ queryKey: SSH_CONNECTIONS_KEY });
    },
  });
}

/**
 * Helper to get a single connection from cache by ID
 * Returns undefined if not in cache yet
 */
export function useGetConnectionById(id: number | undefined) {
  const { data: connections } = useSshConnectionsQuery();

  if (id === undefined) return undefined;

  return connections?.find((conn) => conn.id === id);
}
