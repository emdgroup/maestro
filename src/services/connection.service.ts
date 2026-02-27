import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { commands, SshAuthMethod, SshConnection } from "@/types/bindings";

/**
 * Query key factory for SSH connection-related queries
 * Ensures consistent cache invalidation across components
 */
const connectionQueryKeys = {
  baseKey: ["ssh-connections"] as const,
  lists: () => [...connectionQueryKeys.baseKey, "list"] as const,
  list: () => [...connectionQueryKeys.lists()] as const,
  details: () => [...connectionQueryKeys.baseKey, "detail"] as const,
  detail: (connectionId: number | string) =>
    [...connectionQueryKeys.details(), connectionId] as const,
};

/**
 * Query hook for fetching all SSH connections from database
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnections() {
  return useQuery({
    queryKey: connectionQueryKeys.list(),
    queryFn: async () => {
      const result = await commands.getSshConnections();
      if (result.status === "ok") {
        return result.data;
      }
    },
  });
}

/**
 * Query hook for fetching the connection matching an id
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnectionById(connectionId: number) {
  return useQuery({
    queryKey: connectionQueryKeys.detail(connectionId),
    queryFn: () => commands.getSshConnection(connectionId),
  });
}

/**
 * Mutation hook for creating a new SSH connection
 */
export function useCreateSshConnection() {
  return useMutation({
    mutationFn: async ({
      connectionString,
      authMethod,
    }: {
      connectionString: string;
      authMethod: SshAuthMethod;
    }) => {
      return await commands.saveSshConnection(connectionString, authMethod);
    },
    onSuccess: () => {
      toast.success("SSH connection created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to create SSH connection: ${error}`);
    },
  });
}

/**
 * Mutation hook for connecting to SSH without credentials
 */
export function useConnectSsh() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ connectionId }: { connectionId: number }) => {
      return await commands.connectSshWithoutCredentials(connectionId);
    },
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch with new connection
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to create SSH connection: ${error}`);
    },
  });
}

/**
 * Mutation hook for connecting to SSH with credentials
 */
export function useConnectSshWithCreds() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      connectionId,
      password,
      savePassword,
    }: {
      connectionId: number;
      password: string;
      savePassword: boolean;
    }) => {
      return await commands.connectSshWithPassword(connectionId, password, savePassword);
    },
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch with new connection
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to create SSH connection: ${error}`);
    },
  });
}

/**
 * Mutation hook for updating SSH connection display name
 * Uses optimistic updates for instant UI feedback
 */
export function useUpdateSshConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      connectionId,
      displayName,
    }: {
      connectionId: number;
      displayName: string;
    }) => {
      await commands.renameSshConnection(connectionId, displayName);
    },
    onMutate: async ({ connectionId, displayName }) => {
      // Cancel any outgoing refetches to prevent overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: connectionQueryKeys.list() });

      // Snapshot the previous value for rollback on error
      const previousConnections = queryClient.getQueryData<SshConnection[]>(
        connectionQueryKeys.list(),
      );

      // Optimistically update the cache
      queryClient.setQueryData<SshConnection[]>(connectionQueryKeys.list(), (old) => {
        if (!old) return old;
        return old.map((conn) =>
          conn.id === connectionId ? { ...conn, display_name: displayName } : conn,
        );
      });

      // Return context with snapshot for potential rollback
      return { previousConnections };
    },
    onError: (error, _variables, context) => {
      // Rollback to previous state on error
      if (context?.previousConnections) {
        queryClient.setQueryData(connectionQueryKeys.list(), context.previousConnections);
      }
      toast.error(`Failed to rename connection: ${error}`);
    },
    onSuccess: () => {
      toast.success("Connection renamed successfully");
    },
    onSettled: async () => {
      // Always refetch after mutation to ensure cache is in sync with server
      await queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
    },
  });
}

/**
 * Mutation hook for deleting an SSH connection
 */
export function useDeleteSshConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectionId: number) => {
      await commands.deleteSshConnection(connectionId);
    },
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch without deleted connection
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("Connection deleted successfully");
    },
    onError: (error) => {
      toast.error(`Failed to delete connection: ${error}`);
    },
  });
}

/**
 * Mutation hook for forgetting saved password for an SSH connection
 */
export function useForgetSavedPassword() {
  return useMutation({
    mutationFn: async (connectionId: number) => {
      await commands.forgetSavedPassword(connectionId);
    },
    onSuccess: () => {
      toast.success("Password forgotten successfully");
    },
    onError: (error) => {
      toast.error(`Failed to forget password: ${error}`);
    },
  });
}
