import { useEffect } from "react";
import { join, tempDir } from "@tauri-apps/api/path";
import { open as openDirPicker } from "@tauri-apps/plugin-dialog";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler, getErrorMessage } from "@/lib/error-utils";
import { toast } from "sonner";
import { useConfigStore } from "@/store/configStore";
import { connectionKeyId, useHomeStore } from "@/store/homeStore";
import type { ConnectionPhase } from "@/store/homeStore";
import type { ConnectionKey, SshAuthMethod } from "@/types/bindings";
import type { AuthSubmission } from "@/views/home/ssh-auth-modal/ssh-auth-utils";

/**
 * Query key factory for SSH connection-related queries
 * Ensures consistent cache invalidation across components
 */
export const connectionQueryKeys = {
  base: ["connections"] as const,
  list: () => [...connectionQueryKeys.base, "list"] as const,
  details: (connectionId: number | string) =>
    [...connectionQueryKeys.base, "detail", connectionId] as const,
  fileBrowser: () => [...connectionQueryKeys.base, "fileBrowser"] as const,
  dirs: (connectionId: number | null | undefined, path: string) =>
    [...connectionQueryKeys.fileBrowser(), connectionId ?? "local", path] as const,
  /** Every listing on one connection, for a write that can change a parent nobody named. */
  dirContentsOn: (connection: ConnectionKey | null | undefined) =>
    [...connectionQueryKeys.fileBrowser(), "dir", connection] as const,
  dirContents: (
    connection: ConnectionKey | null | undefined,
    path: string,
    includeHidden: boolean,
  ) => [...connectionQueryKeys.dirContentsOn(connection), path, includeHidden] as const,
  workspaceFilesOn: (connection: ConnectionKey | null | undefined) =>
    [...connectionQueryKeys.fileBrowser(), "workspace", connection] as const,
  workspaceFiles: (
    connection: ConnectionKey | null | undefined,
    path: string,
    includeHidden: boolean,
  ) => [...connectionQueryKeys.workspaceFilesOn(connection), path, includeHidden] as const,
  artifacts: (connection: ConnectionKey, cwd: string | null | undefined, sinceMs: number | null) =>
    [...connectionQueryKeys.fileBrowser(), "artifacts", connection, cwd, sinceMs] as const,
  read: (connection: ConnectionKey | null | undefined, path: string | null) =>
    [...connectionQueryKeys.fileBrowser(), "read", connection, path] as const,
  readBinary: (connection: ConnectionKey | null | undefined, path: string | null) =>
    [...connectionQueryKeys.fileBrowser(), "readBinary", connection, path] as const,
  defaultPath: () => [...connectionQueryKeys.fileBrowser(), "defaultPath"] as const,
  drives: () => [...connectionQueryKeys.fileBrowser(), "drives"] as const,
  status: (connectionId: number | null) =>
    [...connectionQueryKeys.base, "status", connectionId] as const,
  file: (connection: ConnectionKey, path: string | null, binary: boolean) =>
    [...connectionQueryKeys.base, "file", connection, path, binary] as const,
  localImage: (path: string) => [...connectionQueryKeys.base, "localImage", path] as const,
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
    queryKey: connectionQueryKeys.file(connection, path, binary),
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
    queryKey: connectionQueryKeys.status(connectionId),
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

export function useListDirectories(
  connectionId: number | null | undefined,
  path: string,
  enabled = true,
) {
  const connection: ConnectionKey = connectionId ? { type: "ssh", id: connectionId } : LOCAL;
  return useQuery({
    queryKey: connectionQueryKeys.dirs(connectionId, path),
    queryFn: () => api.listDirectories(connection, path),
    enabled,
  });
}

export function useListDirContents(
  connection: ConnectionKey | null | undefined,
  path: string,
  includeHidden = false,
) {
  return useQuery({
    queryKey: connectionQueryKeys.dirContents(connection, path, includeHidden),
    queryFn: () => api.listContents(connection ?? LOCAL, path, includeHidden),
    enabled: !!path,
    staleTime: 10_000,
  });
}

export function useListWorkspaceFiles(
  connection: ConnectionKey | null | undefined,
  path: string,
  includeHidden = false,
) {
  return useQuery({
    queryKey: connectionQueryKeys.workspaceFiles(connection, path, includeHidden),
    queryFn: () => api.listWorkspaceFiles(connection ?? LOCAL, path, includeHidden),
    enabled: !!path,
    staleTime: 30_000,
  });
}

/**
 * Files in the session's artifact folders changed since it started. Polled rather than read off
 * the tool calls: an agent that writes through a script reports no file at all.
 */
export function useArtifactFiles(
  connection: ConnectionKey,
  cwd: string | null | undefined,
  sinceMs: number | null,
  poll: boolean,
) {
  return useQuery({
    queryKey: connectionQueryKeys.artifacts(connection, cwd, sinceMs),
    queryFn: () => api.listArtifactFiles(connection, cwd!, sinceMs!),
    enabled: !!cwd && sinceMs != null,
    refetchInterval: poll ? 10_000 : false,
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
    queryKey: connectionQueryKeys.read(connection, path),
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
    queryKey: connectionQueryKeys.readBinary(connection, path),
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
    queryClient.invalidateQueries({ queryKey: connectionQueryKeys.dirContentsOn(connection) });
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

/** Every saved-connection list Home reads: SSH, WSL and Docker. */
export function invalidateConnections(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() }),
    queryClient.invalidateQueries({ queryKey: wslQueryKeys.connections() }),
    queryClient.invalidateQueries({ queryKey: dockerQueryKeys.connections() }),
  ]);
}

/**
 * Forget a saved connection, whatever its kind, and put its Home panel back to idle. No `onError`:
 * the connection menu that runs it shows the failure itself.
 */
export function useDeleteConnectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connection: ConnectionKey) => {
      if (connection.type === "ssh") await api.deleteSshConnection(connection.id);
      if (connection.type === "wsl") await api.deleteWslConnection(connection.id);
      if (connection.type === "docker") await api.deleteDockerConnection(connection.id);
    },
    onSuccess: (_data, connection) => {
      useHomeStore.getState().setPhase(connectionKeyId(connection), { kind: "idle" });
      return invalidateConnections(queryClient);
    },
  });
}

/**
 * Save an SSH host and sign in to it the way `authMethod` says. A host that refuses the sign-in was
 * never confirmed, so it is not kept.
 */
export async function addSshConnection(
  address: string,
  authMethod: SshAuthMethod,
  password: string,
  name: string,
): Promise<ConnectionKey> {
  const id = await api.createSshConnection(address, authMethod);
  try {
    if (authMethod === "Agent") await api.connectSshWithAgent(id);
    else if ("KeyFile" in authMethod)
      await api.connectSshWithKey(id, authMethod.KeyFile.path, null, false);
    else if ("Password" in authMethod)
      await api.connectSshWithPassword(id, password, authMethod.Password.save_password);
  } catch (error) {
    await api.deleteSshConnection(id).catch(console.error);
    throw error;
  }
  if (name) await api.renameSshConnection(id, name);
  return { type: "ssh", id };
}

export async function addWslConnection(distro: string): Promise<ConnectionKey> {
  const connection = await api.saveWslConnection(distro, null);
  return { type: "wsl", id: connection.id };
}

export async function addDockerConnection(name: string, image: string): Promise<ConnectionKey> {
  const connection = await api.saveDockerConnection(name, image, null);
  return { type: "docker", id: connection.id };
}

const setPhase = (id: string, phase: ConnectionPhase) =>
  useHomeStore.getState().setPhase(id, phase);

/**
 * Attach to the connection's Maestro server: deploy it when needed, start the relay to it and
 * check the tools agents need. `replace` updates a server from another build that is in use.
 */
export async function attach(connection: ConnectionKey, replace = false) {
  const id = connectionKeyId(connection);
  const before = useHomeStore.getState().phases[id]?.kind;
  setPhase(id, {
    kind: "connecting",
    step: 1,
    starting: before === "stopped" || before === "stopping",
  });
  let result;
  try {
    result = await api.preflightConnection(connection, replace);
  } catch (error) {
    setPhase(id, { kind: "failed", error: getErrorMessage(error), result: null });
    return;
  }
  useConfigStore.getState().setPreflightToolChecks(connection, result.tool_checks);
  // Once per attach; the Usage view syncs again while it is open.
  void api
    .syncUsage(connection)
    .catch((error: unknown) => console.warn("could not sync usage", getErrorMessage(error)));
  setPhase(
    id,
    result.tool_checks.some((tool) => !tool.available)
      ? { kind: "failed", error: null, result }
      : { kind: "up" },
  );
}

/**
 * Connect: sign in to an SSH host with what it already has (agent, key, saved password) and fall
 * back to the inline password form; every other kind of connection attaches straight away.
 */
export async function connect(connection: ConnectionKey) {
  if (connection.type === "ssh") {
    setPhase(connectionKeyId(connection), { kind: "connecting", step: 0 });
    try {
      await api.connectSshWithoutCredentials(connection.id);
    } catch {
      setPhase(connectionKeyId(connection), { kind: "signin", error: null });
      return;
    }
  }
  await attach(connection);
}

export async function signIn(
  connection: Extract<ConnectionKey, { type: "ssh" }>,
  password: string,
  remember: boolean,
  host: string,
) {
  const id = connectionKeyId(connection);
  if (!password) {
    setPhase(id, { kind: "signin", error: `Enter the password for ${host}.` });
    return;
  }
  setPhase(id, { kind: "connecting", step: 0 });
  try {
    await api.connectSshWithPassword(connection.id, password, remember);
  } catch (error) {
    setPhase(id, { kind: "signin", error: getErrorMessage(error) });
    return;
  }
  await attach(connection);
}

/** Sign in to an SSH host with what the sign-in dialog collected. The caller attaches after. */
export async function signInWith(
  connection: Extract<ConnectionKey, { type: "ssh" }>,
  submission: AuthSubmission,
) {
  if (submission.method === "password")
    await api.connectSshWithPassword(connection.id, submission.password, submission.savePassword);
  if (submission.method === "key-file")
    await api.connectSshWithKey(
      connection.id,
      submission.keyPath,
      submission.passphrase ?? null,
      submission.savePassphrase,
    );
  if (submission.method === "agent") await api.connectSshWithAgent(connection.id);
}

/** A relay that ends, or an SSH host that gives up reconnecting, leaves its panel unreachable. */
export function useConnectionLossEvents() {
  useEffect(() => {
    const markUnreachable = (connection: ConnectionKey) => {
      const id = connectionKeyId(connection);
      if (useHomeStore.getState().phases[id]?.kind === "up") {
        setPhase(id, { kind: "unreachable" });
      }
    };
    const unlisteners = Promise.all([
      listen<{ connection: ConnectionKey }>("acp://connection-lost", (event) =>
        markUnreachable(event.payload.connection),
      ),
      listen<number>("ssh-connection-failed", (event) =>
        markUnreachable({ type: "ssh", id: event.payload }),
      ),
    ]);
    return () => {
      void unlisteners.then((stops) => stops.forEach((stop) => stop()));
    };
  }, []);
}

/** Open a path on this machine with whatever the OS opens it with. */
export const openLocalPath = (path: string) => api.openPathNative(path);

/** A file's text as it is on disk now, for a caller comparing it before a write. */
export const readFile = (connection: ConnectionKey, path: string) => api.readFile(connection, path);

/** A local image as a `data:` URL, for a preview of a file that is not uploaded yet. */
export function useLocalImageDataUrl(localAbsPath: string, mime: string) {
  return useQuery({
    queryKey: connectionQueryKeys.localImage(localAbsPath),
    queryFn: async () => `data:${mime};base64,${await api.readLocalFileBinary(localAbsPath)}`,
    staleTime: Infinity,
  });
}

/**
 * Where a remote file is staged so a host application can open it. The file is a copy: edits made
 * in whatever opens it do not travel back.
 */
async function hostCopyPath(absolutePath: string): Promise<string> {
  const basename = absolutePath.split("/").pop() ?? "file";
  return join(await tempDir(), "maestro", basename);
}

/**
 * Whether [openFileWithConnection] stages a copy on the host before opening it, rather than
 * opening the file where it already lives. Lives here rather than in the callers so the answer
 * cannot drift from the branches below that decide it.
 */
export function opensViaHostCopy(connection: ConnectionKey): boolean {
  return connection.type === "ssh" || connection.type === "docker";
}

export async function openFileWithConnection(
  connection: ConnectionKey,
  absolutePath: string,
  opts?: { sshConnectionId?: number; wslDistroName?: string; transferId?: string },
): Promise<void> {
  if (connection.type === "local") {
    await api.openPathNative(absolutePath);
  } else if (connection.type === "ssh" && opts?.sshConnectionId != null) {
    const basename = absolutePath.split("/").pop() ?? "file";
    const localPath = await hostCopyPath(absolutePath);
    const transferId = opts.transferId ?? `open-${basename}`;
    await api.sftpDownload(opts.sshConnectionId, absolutePath, localPath, transferId);
    await api.openPathNative(localPath);
  } else if (connection.type === "wsl" && opts?.wslDistroName) {
    // The distro is asked rather than prefixing \\wsl.localhost\ here, because a path under /mnt
    // is a file on this machine's own disk and should open from there, not through the share.
    const winPath = await api.wslToWindowsPath(opts.wslDistroName, absolutePath);
    await api.openPathNative(winPath);
  } else if (connection.type === "docker") {
    const localPath = await hostCopyPath(absolutePath);
    await api.dockerDownloadFile(connection.id, absolutePath, localPath);
    await api.openPathNative(localPath);
  } else {
    // Falling through used to resolve successfully having done nothing, which is indistinguishable
    // from a working open to every caller here. Reached when a WSL distro name has not loaded yet.
    throw new Error(`Cannot open '${absolutePath}' over this ${connection.type} connection yet`);
  }
}

/**
 * Copy a file off whichever machine the connection names into a folder the user picks.
 *
 * `transferId` names the channel `sftp://transfer-progress/` reports on, and only SSH reports:
 * the distro copy and `docker cp` are each one opaque call with no byte counts to forward.
 *
 * Returns where the file landed, or null when the folder picker was dismissed — the caller needs
 * to tell those apart to avoid confirming a copy that never happened.
 */
export async function downloadFileToFolder(
  connection: ConnectionKey,
  absolutePath: string,
  transferId: string,
): Promise<string | null> {
  const chosen = await openDirPicker({ directory: true });
  if (!chosen) return null;
  const basename = absolutePath.split("/").pop() ?? "file";
  const destPath = await join(chosen as string, basename);

  if (connection.type === "ssh") {
    await api.sftpDownload(connection.id, absolutePath, destPath, transferId);
  } else if (connection.type === "wsl") {
    await api.wslDownloadFile(connection.id, absolutePath, destPath);
  } else if (connection.type === "docker") {
    await api.dockerDownloadFile(connection.id, absolutePath, destPath);
  } else {
    // Local has nothing to copy from — callers hide the action rather than reaching this.
    throw new Error(`Cannot download '${absolutePath}' over this ${connection.type} connection`);
  }
  return destPath;
}
