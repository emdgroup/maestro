import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type { ConnectionKey } from "@/types/bindings";

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
  file: (connection: ConnectionKey, path: string, binary: boolean) =>
    [...connectionQueryKeys.base, "file", connection, path, binary] as const,
};

/**
 * Contents of a file at an absolute path on a connection, for paths outside any session's
 * working directory. Pass `null` for the path to disable the query; `refetchIntervalMs`
 * polls a file that is still being written.
 */
export function useConnectionFileQuery(
  connection: ConnectionKey,
  path: string | null,
  binary: boolean,
  refetchIntervalMs?: number,
) {
  return useQuery({
    queryKey: connectionQueryKeys.file(connection, path ?? "", binary),
    queryFn: () =>
      binary ? api.readFileBinary(connection, path!) : api.readFile(connection, path!),
    enabled: path != null,
    refetchInterval: refetchIntervalMs ?? false,
  });
}

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
 * Whether an SSH host answers: a live session, else a TCP probe of its port with a 3s timeout.
 * No data until the first probe lands, so a host that is up never flickers. Null stops probing.
 */
export function useSshReachable(connectionId: number | null) {
  return useQuery({
    queryKey: connectionQueryKeys.status(connectionId ?? 0),
    queryFn: async () => (await api.getSshConnectionStatus(connectionId!)).connected,
    enabled: connectionId !== null,
    refetchInterval: 15_000,
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
 * Mutation hook for listing remote directories via SSH
 * Used by file browser to navigate remote filesystem
 */
const LOCAL: ConnectionKey = { type: "local" };

export function useListDirectories(connectionId: number | null | undefined, path: string) {
  const connection: ConnectionKey = connectionId ? { type: "ssh", id: connectionId } : LOCAL;
  return useQuery({
    queryKey: connectionQueryKeys.dirs(connectionId, path),
    queryFn: () => api.listDirectories(connection, path),
  });
}

export function useListDirContents(
  connection: ConnectionKey | null | undefined,
  path: string,
  includeHidden = false,
) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection, path, includeHidden],
    queryFn: () => api.listContents(connection ?? LOCAL, path, includeHidden),
    enabled: !!path,
    staleTime: 10_000,
  });
}

export function useListContents(connection: ConnectionKey | null | undefined, path: string) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), connection, path],
    queryFn: () => api.listContents(connection ?? LOCAL, path, false),
    enabled: !!path,
  });
}

export function useListWorkspaceFiles(
  connection: ConnectionKey | null | undefined,
  path: string,
  includeHidden = false,
) {
  return useQuery({
    queryKey: [...connectionQueryKeys.fileBrowser(), "workspace", connection, path, includeHidden],
    queryFn: () => api.listWorkspaceFiles(connection ?? LOCAL, path, includeHidden),
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
    queryFn: () => api.readFile(connection ?? LOCAL, path!),
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
    queryFn: () => api.readFileBinary(connection ?? LOCAL, path!),
    enabled: !!path,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval,
  });
}

/**
 * Replace a file's contents on whichever machine the connection points at.
 *
 * No cache invalidation here: the Files tab re-baselines from the text it just wrote and resumes
 * its own polling on leaving edit mode, so invalidating would only cost a redundant read.
 */
export function useWriteFile() {
  return useMutation({
    mutationFn: ({
      connection,
      path,
      contents,
    }: {
      connection: ConnectionKey;
      path: string;
      contents: string;
    }) => api.writeFile(connection, path, contents),
  });
}

/**
 * Invalidate every cached directory listing for a connection. The listings are keyed by directory,
 * and a create or rename can change a parent this hook does not know about, so it drops all of
 * them — only mounted queries (the tree root and expanded folders) actually refetch.
 */
function useInvalidateFileBrowser() {
  const queryClient = useQueryClient();
  return (connection: ConnectionKey) =>
    queryClient.invalidateQueries({
      queryKey: [...connectionQueryKeys.fileBrowser(), "dir", connection],
    });
}

export function useCreateFile() {
  const invalidate = useInvalidateFileBrowser();
  return useMutation({
    mutationFn: ({ connection, path }: { connection: ConnectionKey; path: string }) =>
      api.createFileAt(connection, path),
    onSuccess: (_data, { connection }) => void invalidate(connection),
    onError: createErrorToastHandler("Failed to create file"),
  });
}

export function useCreateDirectory() {
  const invalidate = useInvalidateFileBrowser();
  return useMutation({
    mutationFn: ({ connection, path }: { connection: ConnectionKey; path: string }) =>
      api.createDirectoryAt(connection, path),
    onSuccess: (_data, { connection }) => void invalidate(connection),
    onError: createErrorToastHandler("Failed to create folder"),
  });
}

export function useRenamePath() {
  const invalidate = useInvalidateFileBrowser();
  return useMutation({
    mutationFn: ({
      connection,
      from,
      to,
    }: {
      connection: ConnectionKey;
      from: string;
      to: string;
    }) => api.renameFile(connection, from, to),
    onSuccess: (_data, { connection }) => void invalidate(connection),
    onError: createErrorToastHandler("Failed to rename"),
  });
}

export function useDeletePath() {
  const invalidate = useInvalidateFileBrowser();
  return useMutation({
    mutationFn: ({
      connection,
      path,
      recursive,
    }: {
      connection: ConnectionKey;
      path: string;
      recursive: boolean;
    }) => api.deleteFile(connection, path, recursive),
    onSuccess: (_data, { connection }) => void invalidate(connection),
    onError: createErrorToastHandler("Failed to delete"),
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
