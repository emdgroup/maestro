import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type {
  ConnectionKey,
  ProjectConfigRequest,
  ProjectConfigResponse,
  ProfilesDocument,
} from "@/types/bindings";
import { localConnectionId } from "@/contexts/ConnectionContext";

/**
 * Project service providing type-safe operations for project management.
 * All project-related IPC calls are centralized here.
 */

/**
 * Query key factory for project-related queries
 * Ensures consistent cache invalidation across components
 */
export const projectQueryKeys = {
  base: ["projects"] as const,
  list: () => [...projectQueryKeys.base, "list"] as const,
  listByConnection: (connectionId: number | string) =>
    [...projectQueryKeys.list(), connectionId] as const,
  details: (id: number) => [...projectQueryKeys.base, "details", id] as const,
  settings: () => [...projectQueryKeys.base, "settings"] as const,
  settingsDetail: (projectId: number) => [...projectQueryKeys.settings(), projectId] as const,
  locks: (ids: number[]) => [...projectQueryKeys.base, "locks", ids] as const,
  profiles: (projectId: number) => [...projectQueryKeys.base, "profiles", projectId] as const,
  remotes: (projectId: number) => [...projectQueryKeys.base, "remotes", projectId] as const,
};

/**
 * Query hook for fetching all projects
 */
export function useProjects() {
  return useQuery({
    queryKey: projectQueryKeys.list(),
    queryFn: () => api.getProjects(),
    staleTime: Infinity,
  });
}

export function connectionQueryKey(connection: ConnectionKey): number | string {
  if (connection.type === "docker") return `docker-${connection.id}`;
  if (connection.type === "wsl") return `wsl-${connection.id}`;
  if (connection.type === "ssh") return connection.id;
  return localConnectionId;
}

export function useRecentProjects(connection: ConnectionKey) {
  return useQuery({
    queryKey: projectQueryKeys.listByConnection(connectionQueryKey(connection)),
    queryFn: () => api.getConnectionProjects(connection),
    staleTime: Infinity,
  });
}

/**
 * Query hook for fetching a single project by ID
 */
export function useProjectById(projectId: number) {
  return useQuery({
    queryKey: projectQueryKeys.details(projectId),
    queryFn: () => api.getProject(projectId),
    staleTime: Infinity,
  });
}

/**
 * Query hook for fetching project settings/configuration
 */
export function useProjectSettings(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.settingsDetail(projectId ?? -1),
    queryFn: () => {
      if (projectId == null) throw new Error("projectId required");
      return api.getProjectSettings(projectId);
    },
    staleTime: Infinity,
    enabled: projectId != null,
  });
}

/**
 * The project's configured git remotes, for the Settings picker.
 *
 * Short stale time rather than `Infinity`: a user who adds a remote to fix an empty Remote tab
 * expects to find it here, and a `git remote -v` is cheap next to that confusion.
 */
export function useProjectRemotes(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.remotes(projectId ?? -1),
    queryFn: () => {
      if (projectId == null) throw new Error("projectId required");
      return api.listProjectRemotes(projectId);
    },
    staleTime: 30_000,
    enabled: projectId != null,
  });
}

/**
 * Query hook for checking which projects are locked by another Maestro instance.
 * Refetches on window focus to detect locks acquired while the window was backgrounded.
 */
export function useProjectLocks(projectIds: number[]) {
  return useQuery({
    queryKey: projectQueryKeys.locks(projectIds),
    queryFn: () => api.checkProjectLocks(projectIds),
    enabled: projectIds.length > 0,
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Mutation hook for creating a new project
 */
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, connection }: { path: string; connection: ConnectionKey }) =>
      api.createProject(path, connection),
    onSuccess: (_data, { connection }) => {
      const key =
        connection.type === "wsl"
          ? projectQueryKeys.listByConnection(`wsl-${connection.id}`)
          : connection.type === "ssh"
            ? projectQueryKeys.listByConnection(connection.id)
            : projectQueryKeys.listByConnection("local");
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: createErrorToastHandler("Failed to create project"),
  });
}

/**
 * Mutation hook for deleting a project
 */
export function useDeleteProject(connectionId: number | string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: number) => api.deleteProject(projectId),
    onSuccess: (_data, projectId) => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.details(projectId) });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? localConnectionId),
      });
    },
    onError: createErrorToastHandler("Failed to delete project"),
  });
}

/**
 * Mutation hook for updating project settings
 */
/**
 * Query hook for a project's agent profiles — which agent, model and permission mode each
 * pipeline role runs with.
 *
 * Stored in the project's own `.maestro/profiles.json` rather than Maestro's database, so the
 * whole team gets the same pipeline from the repository. Until now nothing in the UI read or
 * wrote it and the file had to be edited by hand.
 */
export function useAgentProfilesQuery(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.profiles(projectId!),
    queryFn: () => api.listAgentProfiles(projectId!),
    enabled: projectId != null,
  });
}

/**
 * Mutation hook for saving a project's agent profiles.
 *
 * Whole-document, matching the command: the Rust side validates ids are present and unique across
 * the set, which cannot be checked one profile at a time.
 */
export function useSaveAgentProfilesMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, document }: { projectId: number; document: ProfilesDocument }) =>
      api.saveAgentProfiles(projectId, document),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.profiles(projectId) });
    },
    onError: createErrorToastHandler("Failed to save agent profiles"),
  });
}

/**
 * Mutation hook for the settings page's project-level fields.
 *
 * Optimistic, because the settings page saves on every change rather than behind a button: the
 * write is a file round trip — an SSH one for a remote project — and a switch that visibly
 * snaps back for its duration reads as the click not having registered.
 */
export function useUpdateProjectSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: number; config: ProjectConfigRequest }) =>
      api.updateProjectSettings(projectId, config),
    onMutate: async ({ projectId, config }) => {
      const queryKey = projectQueryKeys.settingsDetail(projectId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ProjectConfigResponse>(queryKey);
      if (previous) queryClient.setQueryData(queryKey, { ...previous, ...config });
      return { previous, queryKey };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      createErrorToastHandler("Failed to update project settings")(error);
    },
    onSettled: (_data, _error, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(projectId),
      });
      // `remote_name` decides which refs the branch lists contain, and that query caches for a
      // minute — without this, changing the remote leaves the picker showing the old one's
      // branches with nothing to suggest a refresh is needed.
      void queryClient.invalidateQueries({ queryKey: ["tasks", "branches", projectId] });
    },
  });
}

/**
 * Mutation hook for setting only the project's accent colour.
 * Separate from useUpdateProjectSettings so the settings form's whole-config save can never
 * clobber a colour picked in the header (the request type has no colour field by design).
 */
export function useSetProjectAccentColor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, accentColor }: { projectId: number; accentColor: string | null }) =>
      api.setProjectAccentColor(projectId, accentColor),
    // On settle, not on success: the caller paints the new colour optimistically, so a failed
    // write has to refetch too or the UI keeps showing a colour that was never stored.
    onSettled: (_data, _error, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to set project color"),
  });
}

/**
 * Mutation hook for initializing git in a non-git directory.
 * Called silently before createProject when user selects a non-git folder.
 */
export function useGitInitProject() {
  return useMutation({
    mutationFn: ({
      path,
      connectionId,
      wslConnectionId,
      dockerConnectionId,
    }: {
      path: string;
      connectionId: number | null;
      wslConnectionId: number | null;
      dockerConnectionId: number | null;
    }) => api.gitInitProject(path, connectionId, wslConnectionId, dockerConnectionId),
    // No cache invalidation needed — this is a pre-step before createProject
    // No toast on success — this is a silent auto-init
    onError: createErrorToastHandler("Failed to initialize git"),
  });
}

export function useCheckIsGitRepo() {
  return useMutation({
    mutationFn: ({
      path,
      connectionId,
      wslConnectionId,
      dockerConnectionId,
    }: {
      path: string;
      connectionId: number | null;
      wslConnectionId: number | null;
      dockerConnectionId: number | null;
    }) => api.checkIsGitRepo(path, connectionId, wslConnectionId, dockerConnectionId),
  });
}

export function useCloneProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      url,
      targetPath,
      connectionId,
      wslConnectionId,
      dockerConnectionId,
      provider,
    }: {
      url: string;
      targetPath: string;
      connectionId: number | null;
      wslConnectionId: number | null;
      dockerConnectionId: number | null;
      provider?: string | null;
    }) =>
      api.cloneProject(
        url,
        targetPath,
        connectionId,
        wslConnectionId,
        dockerConnectionId,
        provider ?? null,
      ),
    onSuccess: (_, { connectionId, wslConnectionId, dockerConnectionId }) => {
      const key =
        dockerConnectionId != null
          ? projectQueryKeys.listByConnection(`docker-${dockerConnectionId}`)
          : wslConnectionId != null
            ? projectQueryKeys.listByConnection(`wsl-${wslConnectionId}`)
            : projectQueryKeys.listByConnection(connectionId ?? "local");
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success("Project cloned successfully");
    },
    onError: createErrorToastHandler("Clone failed"),
  });
}

/**
 * Mutation hook for creating a new project directory with git init.
 * Returns the created Project on success.
 * Note: onError does NOT show a toast — the Create dialog shows inline errors.
 */
export function useCreateNewProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      parentDir,
      folderName,
      connectionId,
      wslConnectionId,
      dockerConnectionId,
    }: {
      parentDir: string;
      folderName: string;
      connectionId: number | null;
      wslConnectionId: number | null;
      dockerConnectionId: number | null;
    }) =>
      api.createNewProject(
        parentDir,
        folderName,
        connectionId,
        wslConnectionId,
        dockerConnectionId,
      ),
    onSuccess: (_, { connectionId, wslConnectionId, dockerConnectionId }) => {
      const key =
        dockerConnectionId != null
          ? projectQueryKeys.listByConnection(`docker-${dockerConnectionId}`)
          : wslConnectionId != null
            ? projectQueryKeys.listByConnection(`wsl-${wslConnectionId}`)
            : projectQueryKeys.listByConnection(connectionId ?? "local");
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success("Project created successfully");
    },
    onError: (error) => {
      console.error("Create project failed:", error);
    },
  });
}
