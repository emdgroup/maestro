import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib";
import { toast } from "sonner";
import { SshAuthMethod } from "@/types/bindings";

/**
 * Query key factory for SSH connection-related queries
 * Ensures consistent cache invalidation across components
 */
export const connectionQueryKeys = {
  baseKey: ["ssh-connections"] as const,
  list: () => [...connectionQueryKeys.baseKey, "list"] as const,
  details: (connectionId: number | string) =>
    [...connectionQueryKeys.baseKey, "detail", connectionId] as const,
  fileBrowser: () => [...connectionQueryKeys.baseKey, "file-browser"] as const,
  dirs: (connectionId: number | null | undefined, path: string) =>
    [...connectionQueryKeys.fileBrowser(), connectionId ?? "local", path] as const,
  defaultPath: () => [...connectionQueryKeys.fileBrowser(), "default-path"] as const,
  drives: () => [...connectionQueryKeys.fileBrowser(), "drives"] as const,
};

/**
 * Query hook for fetching all SSH connections from database
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnections() {
  return useQuery({
    queryKey: connectionQueryKeys.list(),
    queryFn: () => api.getSshConnections(),
  });
}

/**
 * Query hook for fetching the connection matching an id
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnectionById(connectionId: number) {
  return useQuery({
    queryKey: connectionQueryKeys.details(connectionId),
    queryFn: () => api.getSshConnection(connectionId),
  });
}

/**
 * Mutation hook for creating a new SSH connection
 */
export function useCreateSshConnection() {
  return useMutation({
    mutationFn: ({
      connectionString,
      authMethod,
    }: {
      connectionString: string;
      authMethod: SshAuthMethod;
    }) => api.saveSshConnection(connectionString, authMethod),
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
    mutationFn: ({ connectionId }: { connectionId: number }) =>
      api.connectSshWithoutCredentials(connectionId),
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch with new connection
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection created successfully");
    },
  });
}

/**
 * Mutation hook for connecting to SSH with credentials
 */
export function useConnectSshWithCreds() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connectionId,
      password,
      savePassword,
    }: {
      connectionId: number;
      password: string;
      savePassword: boolean;
    }) => api.connectSshWithPassword(connectionId, password, savePassword),
    onSuccess: () => {
      // Invalidate the SSH connections list to refetch with new connection
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to connect: ${error}`);
    },
  });
}

/**
 * Mutation hook for connecting to SSH with a key file
 */
export function useConnectSshWithKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      connectionId,
      keyPath,
      passphrase,
    }: {
      connectionId: number;
      keyPath: string;
      passphrase?: string;
    }) => api.connectSshWithKey(connectionId, keyPath, passphrase ?? null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection created successfully");
    },
    onError: (error) => {
      toast.error(`Failed to connect: ${error}`);
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
    mutationFn: ({ connectionId, displayName }: { connectionId: number; displayName: string }) =>
      api.renameSshConnection(connectionId, displayName),
    onSuccess: (_data, { connectionId }) => {
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.details(connectionId) });
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("Connection renamed successfully");
    },
    onError: (error) => {
      toast.error(`Failed to rename connection: ${error}`);
    },
  });
}

/**
 * Mutation hook for deleting an SSH connection
 */
export function useDeleteSshConnection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (connectionId: number) => api.deleteSshConnection(connectionId),
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
    mutationFn: (connectionId: number) => api.forgetSavedPassword(connectionId),
    onSuccess: () => {
      toast.success("Password forgotten successfully");
    },
    onError: (error) => {
      toast.error(`Failed to forget password: ${error}`);
    },
  });
}

/**
 * Mutation hook for listing remote directories via SSH
 * Used by file browser to navigate remote filesystem
 */
export function useListDirectories(connectionId: number | null | undefined, path: string) {
  return useQuery({
    queryKey: connectionQueryKeys.dirs(connectionId, path),
    queryFn: connectionId
      ? () => api.listRemoteDirectories(connectionId, path)
      : () => api.listLocalDirectories(path),
  });
}

/**
 * Query hook for getting default file picker path
 * Returns the user's default directory for file selection (platform-dependent)
 */
export function useGetDefaultFilePickerPath() {
  return useQuery({
    queryKey: connectionQueryKeys.defaultPath(),
    queryFn: () => api.getDefaultFilePickerPath(),
    staleTime: Infinity,
  });
}

/**
 * Query hook for listing available drives on Windows
 * Returns array of drive letters (e.g., ["C:", "D:"])
 */
export function useListDrives() {
  return useQuery({
    queryKey: connectionQueryKeys.drives(),
    queryFn: () => api.listDrives(),
    staleTime: Infinity,
  });
}
