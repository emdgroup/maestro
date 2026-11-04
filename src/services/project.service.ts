import {
  queryOptions,
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { connectionKeyStr } from "@/lib/connection-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type {
  ConnectionKey,
  ProjectConfigRequest,
  ProjectConfigResponse,
  ProfilesDocument,
} from "@/types/bindings";

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
  listByConnection: (connectionId: string) => [...projectQueryKeys.list(), connectionId] as const,
  details: (id: number) => [...projectQueryKeys.base, "details", id] as const,
  settings: () => [...projectQueryKeys.base, "settings"] as const,
  settingsDetail: (projectId: number | null) =>
    [...projectQueryKeys.settings(), projectId] as const,
  locks: () => [...projectQueryKeys.base, "locks"] as const,
  locksFor: (connectionId: string, ids: number[]) =>
    [...projectQueryKeys.locks(), connectionId, ids] as const,
  home: () => [...projectQueryKeys.base, "home"] as const,
  homeFor: (connectionId: string) => [...projectQueryKeys.home(), connectionId] as const,
  profiles: (projectId: number | null) =>
    [...projectQueryKeys.base, "profiles", projectId] as const,
  remotes: (projectId: number | null) => [...projectQueryKeys.base, "remotes", projectId] as const,
  branches: (projectId: number | null) =>
    [...projectQueryKeys.base, "branches", projectId] as const,
};

/**
 * Open a project in this window: take its lock and answer with the project. Imperative, since what
 * follows (priming its server, switching to it) is the caller's sequence.
 */
export const openProject = (projectId: number) => api.openProject(projectId);

/** Start the project's server and bring its board over if it has not moved yet. */
export const primeProjectServer = (projectId: number) => api.primeProjectServer(projectId);

/** Give up the lock `openProject` took, for an open that failed after taking it. */
export const releaseActiveProjectLock = () => api.releaseActiveProjectLock();

/**
 * The project's git branches, as `[BranchList, currentBranch]` where `BranchList` holds the local
 * and remote names.
 */
export function useProjectBranchesQuery(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.branches(projectId),
    queryFn: () => api.listProjectBranches(projectId!),
    enabled: projectId !== null,
    staleTime: 60000, // 1 minute — branches don't change that often
  });
}

/**
 * The request that writes `patch` over the stored settings. The update command takes the whole
 * config, so every field the response carries and the request also has is copied across, or it is
 * written away. With nothing loaded yet each field takes its default.
 */
export function toProjectConfigRequest(
  settings: ProjectConfigResponse | undefined,
  patch: Partial<ProjectConfigRequest>,
): ProjectConfigRequest {
  return {
    default_agent: settings?.default_agent ?? null,
    startup_tab: settings?.startup_tab ?? null,
    default_workspace_mode: settings?.default_workspace_mode ?? "NewWorktree",
    remote_name: settings?.remote_name ?? null,
    base_branch: settings?.base_branch ?? null,
    ...patch,
  };
}

/**
 * Query hook for fetching project settings/configuration
 */
export function useProjectSettings(projectId: number | null) {
  return useQuery(projectSettingsOptions(projectId));
}

/** How a project's settings are read, for the hook and for a prefetch ahead of opening it. */
export function projectSettingsOptions(projectId: number | null) {
  return queryOptions({
    queryKey: projectQueryKeys.settingsDetail(projectId),
    queryFn: () => api.getProjectSettings(projectId!),
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
    queryKey: projectQueryKeys.remotes(projectId),
    queryFn: () => {
      if (projectId == null) throw new Error("projectId required");
      return api.listProjectRemotes(projectId);
    },
    staleTime: 30_000,
    enabled: projectId != null,
  });
}

/**
 * What Home shows for each connection: its server's status and every project on it.
 *
 * Refetched every 5 seconds, and by `useServerEventSync` whenever any server says a task, an
 * automation run or a lock changed. Only ask for attached connections: the rest fail with "No
 * connection server".
 */
export function useHomeSummaryQueries(connections: ConnectionKey[]) {
  return useQueries({
    queries: connections.map((connection) => ({
      queryKey: projectQueryKeys.homeFor(connectionKeyStr(connection)),
      queryFn: () => api.getHomeSummary(connection),
      refetchInterval: 5000,
    })),
  });
}

/** Ask the window holding a project for it. Resolves `true` once it is this window's. */
export function useRequestProjectTakeover() {
  return useMutation({
    mutationFn: (projectId: number) => api.requestProjectTakeover(projectId),
  });
}

/** This window's answer to another window asking for its project. */
export function useAnswerProjectTakeover() {
  return useMutation({
    mutationFn: ({
      connection,
      requestId,
      accept,
    }: {
      connection: ConnectionKey;
      requestId: string;
      accept: boolean;
    }) => api.answerProjectTakeover(connection, requestId, accept),
    onError: createErrorToastHandler("Failed to answer the takeover request"),
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
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.homeFor(connectionKeyStr(connection)),
      });
    },
    onError: createErrorToastHandler("Failed to create project"),
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
    queryKey: projectQueryKeys.profiles(projectId),
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

/** Write a project's starting profiles, which the command skips when it already has the file. */
export function useSeedAgentProfilesMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, document }: { projectId: number; document: ProfilesDocument }) =>
      api.seedAgentProfiles(projectId, document),
    onSuccess: (written, { projectId }) => {
      if (written) {
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.profiles(projectId) });
      }
    },
    onError: createErrorToastHandler("Failed to create the starting agent profiles"),
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
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.branches(projectId) });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.home() });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.home() });
      toast.success("Project created successfully");
    },
    onError: createErrorToastHandler("Failed to create project"),
  });
}
