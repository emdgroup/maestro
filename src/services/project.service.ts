import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { toast } from "sonner";
import type { ProjectConfigRequest, JsonValue } from "@/types/bindings";
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

/**
 * Hook for fetching projects for a specific SSH connection
 */
export function useRecentProjects(connectionId: number | undefined | null) {
  return useQuery({
    queryKey: projectQueryKeys.listByConnection(connectionId ?? localConnectionId),
    queryFn: () => api.getConnectionProjects(connectionId || null),
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
export function useProjectSettings(projectId: number) {
  return useQuery({
    queryKey: projectQueryKeys.settingsDetail(projectId),
    queryFn: () => api.getProjectSettings(projectId),
    staleTime: Infinity,
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
    mutationFn: ({ path, connectionId }: { path: string; connectionId: number | null }) =>
      api.createProject(path, connectionId),
    onSuccess: (_data, { connectionId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? "local"),
      });
    },
    onError: createErrorToastHandler("Failed to create project"),
  });
}

/**
 * Mutation hook for removing a project
 */
export function useRemoveProject(connectionId: number | string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: number) => api.removeProject(projectId),
    onSuccess: (_data, projectId) => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.details(projectId) });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? localConnectionId),
      });
    },
    onError: createErrorToastHandler("Failed to remove project"),
  });
}

/**
 * Mutation hook for updating project settings
 */
export function useUpdateProjectSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: number; config: ProjectConfigRequest }) =>
      api.updateProjectSettings(projectId, config),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to update project settings"),
  });
}

/**
 * Mutation hook for saving import configuration
 */
export function useSaveImportConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, importConfig }: { projectId: number; importConfig: JsonValue }) =>
      api.saveImportConfig(projectId, "jira", importConfig),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to save import config"),
  });
}

/**
 * Mutation hook for initializing git in a non-git directory.
 * Called silently before createProject when user selects a non-git folder.
 */
export function useGitInitProject() {
  return useMutation({
    mutationFn: ({ path, connectionId }: { path: string; connectionId: number | null }) =>
      api.gitInitProject(path, connectionId),
    // No cache invalidation needed — this is a pre-step before createProject
    // No toast on success — this is a silent auto-init
    onError: createErrorToastHandler("Failed to initialize git"),
  });
}

/**
 * Mutation hook for cloning a git repo and registering it as a project.
 * Returns the created Project on success.
 */
export function useCloneProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      url,
      targetPath,
      connectionId,
    }: {
      url: string;
      targetPath: string;
      connectionId: number | null;
    }) => api.cloneProject(url, targetPath, connectionId),
    onSuccess: (_, { connectionId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? "local"),
      });
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
    }: {
      parentDir: string;
      folderName: string;
      connectionId: number | null;
    }) => api.createNewProject(parentDir, folderName, connectionId),
    onSuccess: (_, { connectionId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listByConnection(connectionId ?? "local"),
      });
      toast.success("Project created successfully");
    },
    onError: (error) => {
      // Don't toast here — Create dialog shows inline errors
      // The caller catches the error and displays it in the form
      console.error("Create project failed:", error);
    },
  });
}

/**
 * Mutation hook for syncing GitHub issues
 */
export function useSyncGithubIssues() {
  return useMutation({
    mutationFn: ({
      projectId,
      owner,
      repo,
      token,
    }: {
      projectId: number;
      owner: string;
      repo: string;
      token: string;
    }) => api.syncGithubIssues(projectId, owner, repo, token),
    onSuccess: (data) => {
      toast.success(`Synced ${data.imported_count} issues from GitHub`);
    },
    onError: createErrorToastHandler("Failed to sync GitHub issues"),
  });
}

/**
 * Mutation hook for syncing Jira issues
 */
export function useSyncJiraIssues() {
  return useMutation({
    mutationFn: ({
      projectId,
      host,
      email,
      token,
      jql,
    }: {
      projectId: number;
      host: string;
      email: string;
      token: string;
      jql: string;
    }) => api.syncJiraIssues(projectId, host, email, token, jql),
    onSuccess: (data) => {
      toast.success(`Synced ${data.imported_count} issues from Jira`);
    },
    onError: createErrorToastHandler("Failed to sync Jira issues"),
  });
}
