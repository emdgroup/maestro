import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type { ConnectionKey, SshAuthMethod } from "@/types/bindings";

/**
 * Query key factory for SSH connection-related queries
 * Ensures consistent cache invalidation across components
 */
export const connectionQueryKeys = {
  base: ["ssh-connections"] as const,
  list: () => [...connectionQueryKeys.base, "list"] as const,
  details: (connectionId: number | string) =>
    [...connectionQueryKeys.base, "detail", connectionId] as const,
  fileBrowser: () => [...connectionQueryKeys.base, "file-browser"] as const,
  dirs: (connectionId: number | null | undefined, path: string) =>
    [...connectionQueryKeys.fileBrowser(), connectionId ?? "local", path] as const,
  defaultPath: () => [...connectionQueryKeys.fileBrowser(), "default-path"] as const,
  drives: () => [...connectionQueryKeys.fileBrowser(), "drives"] as const,
  status: (connectionId: number) => [...connectionQueryKeys.base, "status", connectionId] as const,
};

/**
 * Query hook for fetching all SSH connections from database
 * Provides automatic caching, refetching, and synchronization
 */
export function useSshConnections() {
  return useQuery({
    queryKey: connectionQueryKeys.list(),
    queryFn: () => api.listSshConnections(),
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
    }) => api.createSshConnection(connectionString, authMethod),
    onError: createErrorToastHandler("Failed to create SSH connection"),
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
      toast.success("SSH connection successful");
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
      toast.success("SSH connection successful");
    },
    onError: createErrorToastHandler("Failed to connect"),
  });
}

/**
 * Mutation hook for connecting to SSH via SSH agent
 */
export function useConnectSshWithAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ connectionId }: { connectionId: number }) =>
      api.connectSshWithAgent(connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection successful");
    },
    onError: createErrorToastHandler("Failed to connect via agent"),
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
      savePassphrase,
    }: {
      connectionId: number;
      keyPath: string;
      passphrase?: string;
      savePassphrase: boolean;
    }) => api.connectSshWithKey(connectionId, keyPath, passphrase ?? null, savePassphrase),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      toast.success("SSH connection successful");
    },
    onError: createErrorToastHandler("Failed to connect"),
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
      toast.success("Connection renamed");
    },
    onError: createErrorToastHandler("Failed to rename connection"),
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
    },
    onError: createErrorToastHandler("Failed to delete connection"),
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
    onError: createErrorToastHandler("Failed to forget password"),
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

export function useListDirContents(
  connection: ConnectionKey | null | undefined,
  path: string,
  wslDistroName?: string,
  dockerContainerName?: string,
) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection, path],
    queryFn: async () => {
      if (!connection || connection.type === "local") {
        return api.listLocalContents(path);
      }
      if (connection.type === "wsl") {
        return api.listWslContents(wslDistroName!, path);
      }
      if (connection.type === "docker") {
        const names = await api.listDockerDirectories(dockerContainerName!, path);
        return names.map((name) => ({
          name: name.endsWith("/") ? name.slice(0, -1) : name,
          is_dir: name.endsWith("/"),
        }));
      }
      return api.listRemoteContents(connection.id, path);
    },
    enabled:
      !!path &&
      (connection?.type !== "wsl" || !!wslDistroName) &&
      (connection?.type !== "docker" || !!dockerContainerName),
    staleTime: 10_000,
  });
}

export function useListContents(connection: ConnectionKey | null | undefined, path: string) {
  const isWsl = connection?.type === "wsl";
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), connection, path],
    queryFn: () => {
      if (!connection || connection.type === "local") {
        return api.listLocalContents(path);
      }
      return api.listRemoteContents(connection.id, path);
    },
    // ponytail: WSL needs distro name, not connection ID — disabled in V1
    enabled: !!path && !isWsl,
  });
}

export function useListWorkspaceFiles(connection: ConnectionKey | null | undefined, path: string) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "workspace", connection, path],
    queryFn: () => {
      if (!connection || connection.type === "local") {
        return api.listWorkspaceFiles(path);
      }
      if (connection.type === "wsl") {
        return api.listWslWorkspaceFiles(connection.id, path);
      }
      if (connection.type === "docker") {
        return api.listDockerWorkspaceFiles(connection.id, path);
      }
      return api.listRemoteWorkspaceFiles(connection.id, path);
    },
    enabled: !!path,
    staleTime: 30_000,
  });
}

type RefetchInterval =
  | number
  | false
  | ((query: { state: { error: unknown } }) => number | false | undefined);

export function useReadFile(
  connection: ConnectionKey | null | undefined,
  path: string | null,
  options?: { refetchInterval?: RefetchInterval },
) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "read", connection, path],
    queryFn: () => {
      if (!connection || connection.type === "local") {
        return api.readLocalFile(path!);
      }
      if (connection.type === "wsl") {
        return api.readWslFile(connection.id, path!);
      }
      if (connection.type === "docker") {
        return api.readDockerFile(connection.id, path!);
      }
      return api.readRemoteFile(connection.id, path!);
    },
    enabled: !!path,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval,
  });
}

export function useReadFileBinary(
  connection: ConnectionKey | null | undefined,
  path: string | null,
  options?: { refetchInterval?: RefetchInterval },
) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "read-binary", connection, path],
    queryFn: () => {
      if (!connection || connection.type === "local") {
        return api.readLocalFileBinary(path!);
      }
      if (connection.type === "wsl") {
        return api.readWslFileBinary(connection.id, path!);
      }
      if (connection.type === "docker") {
        return api.readDockerFileBinary(connection.id, path!);
      }
      return api.readRemoteFileBinary(connection.id, path!);
    },
    enabled: !!path,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval,
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

export function useSshConnectionStatus(connectionId: number) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const key = connectionQueryKeys.status(connectionId);
    const invalidate = (id: number) => {
      if (id === connectionId) void queryClient.invalidateQueries({ queryKey: key });
    };
    const unsub = Promise.all([
      listen<number>("ssh-connection-lost", (e) => invalidate(e.payload)),
      listen<number>("ssh-connection-failed", (e) => invalidate(e.payload)),
      listen<number>("ssh-reconnected", (e) => invalidate(e.payload)),
    ]).catch(console.error);
    return () => {
      void unsub.then((fns) => {
        if (fns) for (const fn of fns) fn();
      });
    };
  }, [connectionId, queryClient]);

  const query = useQuery({
    queryKey: connectionQueryKeys.status(connectionId),
    queryFn: () => api.getSshConnectionStatus(connectionId),
    refetchInterval: 15000,
    staleTime: 0,
    gcTime: 0,
  });

  // Pessimistic: treat as unreachable until first fresh probe lands (dataUpdatedAt = 0 on mount)
  const connected = !!query.dataUpdatedAt && (query.data?.connected ?? false);

  return { ...query, connected };
}

export const wslQueryKeys = {
  base: ["wsl"] as const,
  distros: () => [...wslQueryKeys.base, "distros"] as const,
  connections: () => [...wslQueryKeys.base, "connections"] as const,
  dirs: (distro: string, path: string) => [...wslQueryKeys.base, "dirs", distro, path] as const,
  home: (distro: string) => [...wslQueryKeys.base, "home", distro] as const,
};

export function useWslDistros() {
  return useQuery({
    queryKey: wslQueryKeys.distros(),
    queryFn: () => api.listWslDistros(),
    staleTime: 30_000,
  });
}

export function useWslConnections() {
  return useQuery({
    queryKey: wslQueryKeys.connections(),
    queryFn: () => api.listWslConnections(),
    staleTime: 30_000,
  });
}

export function useWslDirectories(distro: string, path: string) {
  return useQuery({
    queryKey: wslQueryKeys.dirs(distro, path),
    queryFn: () => api.listWslDirectories(distro, path),
    enabled: !!distro && !!path,
  });
}

export function useWslHome(distro: string) {
  return useQuery({
    queryKey: wslQueryKeys.home(distro),
    queryFn: () => api.getWslHome(distro),
    enabled: !!distro,
    staleTime: Infinity,
  });
}

export function useSaveWslConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ distroName, displayName }: { distroName: string; displayName: string | null }) =>
      api.saveWslConnection(distroName, displayName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: wslQueryKeys.connections() });
    },
  });
}

export function useDeleteWslConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: number) => api.deleteWslConnection(connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: wslQueryKeys.connections() });
    },
    onError: createErrorToastHandler("Failed to remove WSL connection"),
  });
}

export const dockerQueryKeys = {
  base: ["docker"] as const,
  containers: () => [...dockerQueryKeys.base, "containers"] as const,
  connections: () => [...dockerQueryKeys.base, "connections"] as const,
  dirs: (name: string, path: string) => [...dockerQueryKeys.base, "dirs", name, path] as const,
  home: (name: string) => [...dockerQueryKeys.base, "home", name] as const,
};

export function useDockerContainers() {
  return useQuery({
    queryKey: dockerQueryKeys.containers(),
    queryFn: () => api.listDockerContainers(),
    staleTime: 15_000,
  });
}

export function useDockerConnections() {
  return useQuery({
    queryKey: dockerQueryKeys.connections(),
    queryFn: () => api.listDockerConnections(),
    staleTime: 30_000,
  });
}

export function useDockerDirectories(containerName: string, path: string) {
  return useQuery({
    queryKey: dockerQueryKeys.dirs(containerName, path),
    queryFn: () => api.listDockerDirectories(containerName, path),
    enabled: !!containerName && !!path,
  });
}

export function useDockerHome(containerName: string) {
  return useQuery({
    queryKey: dockerQueryKeys.home(containerName),
    queryFn: () => api.getDockerHome(containerName),
    enabled: !!containerName,
    staleTime: Infinity,
  });
}

export function useSaveDockerConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      containerName,
      imageName,
      displayName,
    }: {
      containerName: string;
      imageName: string | null;
      displayName: string | null;
    }) => api.saveDockerConnection(containerName, imageName, displayName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dockerQueryKeys.connections() });
    },
  });
}
