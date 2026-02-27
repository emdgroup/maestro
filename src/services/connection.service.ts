import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "./ipc";
import type { SshConnection } from "@/types/bindings";

/**
 * Query key factory for SSH connection-related queries
 * Ensures consistent cache invalidation across components
 */
export const connectionQueryKeys = {
  all: ["ssh-connections"] as const,
  lists: () => [...connectionQueryKeys.all, "list"] as const,
  list: () => [...connectionQueryKeys.lists()] as const,
  details: () => [...connectionQueryKeys.all, "detail"] as const,
  detail: (connectionId: number | string) =>
    [...connectionQueryKeys.details(), connectionId] as const,
};

/**
 * Connection service providing type-safe operations for SSH connection management.
 * All SSH connection-related IPC calls are centralized here.
 */
export const connectionService = {
  /**
   * Get all SSH connections from database
   */
  async getSshConnections(): Promise<SshConnection[]> {
    return ipc.invoke<SshConnection[]>("get_ssh_connections", {});
  },

  /**
   * Connect to SSH without credentials (using saved config)
   */
  async connectSshWithoutCredentials(
    connectionName: string,
    projectPath?: string
  ): Promise<SshConnection> {
    return ipc.invoke<SshConnection>("connect_ssh_without_credentials", {
      connectionName,
      projectPath: projectPath || "",
    });
  },

  /**
   * Connect to SSH with password
   */
  async connectSshWithPassword(
    connectionName: string,
    password: string,
    projectPath?: string
  ): Promise<SshConnection> {
    return ipc.invoke<SshConnection>("connect_ssh_with_password", {
      connectionName,
      password,
      projectPath: projectPath || "",
    });
  },

  /**
   * Delete SSH connection
   */
  async deleteSshConnection(connectionId: string | number): Promise<void> {
    return ipc.invoke<void>("delete_ssh_connection", { connectionId });
  },

  /**
   * Rename SSH connection
   */
  async renameSshConnection(
    connectionId: string | number,
    newName: string
  ): Promise<void> {
    return ipc.invoke<void>("rename_ssh_connection", { connectionId, newName });
  },

  /**
   * Forget saved password for SSH connection
   */
  async forgetSavedPassword(connectionId: string | number): Promise<void> {
    return ipc.invoke<void>("forget_saved_password", { connectionId });
  },

  /**
   * List local directories (for file picker)
   */
  async listLocalDirectories(path: string): Promise<string[]> {
    return ipc.invoke<string[]>("list_local_directories", { path });
  },

  /**
   * List remote directories (for SSH file picker)
   */
  async listRemoteDirectories(
    connectionId: string | number,
    path: string
  ): Promise<string[]> {
    return ipc.invoke<string[]>("list_remote_directories", { connectionId, path });
  },

  /**
   * List available drives (for Windows)
   */
  async listDrives(): Promise<string[]> {
    return ipc.invoke<string[]>("list_drives");
  },

  /**
   * Get default file picker path
   */
  async getDefaultFilePickerPath(): Promise<string> {
    return ipc.invoke<string>("get_default_file_picker_path");
  },
};

/**
 * Query hook for fetching all SSH connections from database
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnectionsQuery() {
  return useQuery({
    queryKey: connectionQueryKeys.list(),
    queryFn: () => connectionService.getSshConnections(),
    staleTime: 30000, // Consider data fresh for 30 seconds
    refetchOnWindowFocus: true, // Auto-refetch when user returns to tab
  });
}

/**
 * Mutation hook for creating a new SSH connection
 */
export function useCreateSshConnectionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      connectionName,
      password,
      projectPath,
    }: {
      connectionName: string;
      password?: string;
      projectPath?: string;
    }) => {
      if (password) {
        return await connectionService.connectSshWithPassword(
          connectionName,
          password,
          projectPath
        );
      } else {
        return await connectionService.connectSshWithoutCredentials(
          connectionName,
          projectPath
        );
      }
    },
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch with new connection
      queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
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
export function useUpdateSshConnectionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      connectionId,
      displayName,
    }: {
      connectionId: number | string;
      displayName: string;
    }) => {
      await connectionService.renameSshConnection(connectionId, displayName);
    },
    onMutate: async ({ connectionId, displayName }) => {
      // Cancel any outgoing refetches to prevent overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: connectionQueryKeys.list() });

      // Snapshot the previous value for rollback on error
      const previousConnections = queryClient.getQueryData<SshConnection[]>(
        connectionQueryKeys.list()
      );

      // Optimistically update the cache
      queryClient.setQueryData<SshConnection[]>(
        connectionQueryKeys.list(),
        (old) => {
          if (!old) return old;
          return old.map((conn) =>
            conn.id === connectionId || conn.id.toString() === connectionId.toString()
              ? { ...conn, display_name: displayName }
              : conn
          );
        }
      );

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
export function useDeleteSshConnectionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connectionId: number | string) => {
      await connectionService.deleteSshConnection(connectionId);
    },
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch without deleted connection
      queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
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
export function useForgetSavedPasswordMutation() {
  return useMutation({
    mutationFn: async (connectionId: number | string) => {
      await connectionService.forgetSavedPassword(connectionId);
    },
    onSuccess: () => {
      toast.success("Password forgotten successfully");
    },
    onError: (error) => {
      toast.error(`Failed to forget password: ${error}`);
    },
  });
}
