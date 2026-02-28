import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/utils/helpers/tauri-utils";
import { toast } from "sonner";
import type { ProjectConfigRequest } from "@/types";

/**
 * Project service providing type-safe operations for project management.
 * All project-related IPC calls are centralized here.
 */

/**
 * Query key factory for project-related queries
 * Ensures consistent cache invalidation across components
 */
const projectQueryKeys = {
  baseKey: ["projects"] as const,
  list: () => [...projectQueryKeys.baseKey, "list"] as const,
  listByConnection: (connectionId: number) => [...projectQueryKeys.list(), connectionId] as const,
  details: () => [...projectQueryKeys.baseKey, "details"] as const,
  detail: (id: number) => [...projectQueryKeys.details(), id] as const,
  settings: () => [...projectQueryKeys.baseKey, "settings"] as const,
  settingsDetail: (projectId: number) => [...projectQueryKeys.settings(), projectId] as const,
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
    queryKey: projectQueryKeys.listByConnection(connectionId || 0),
    queryFn: () => api.getConnectionProjects(connectionId || null),
    enabled: !!connectionId,
  });
}

/**
 * Query hook for fetching a single project by ID
 */
export function useProjectById(projectId: number) {
  return useQuery({
    queryKey: projectQueryKeys.detail(projectId),
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
 * Mutation hook for creating a new project
 */
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, connectionId }: { path: string; connectionId: number }) =>
      api.createProject(path, connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list() });
    },
    onError: (error) => {
      toast.error(
        `Failed to create project: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for removing a project
 */
export function useRemoveProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: number) => api.removeProject(projectId),
    onSuccess: (_data, projectId) => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list() });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.detail(projectId) });
    },
    onError: (error) => {
      toast.error(
        `Failed to remove project: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
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
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(variables.projectId),
      });
    },
    onError: (error) => {
      toast.error(
        `Failed to update project settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/**
 * Mutation hook for saving import configuration
 */
export function useSaveImportConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      importConfig,
    }: {
      projectId: number;
      importConfig: Record<string, unknown>;
    }) => api.saveImportConfig(projectId, "jira", JSON.parse(importConfig.toString())),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(variables.projectId),
      });
    },
    onError: (error) => {
      toast.error(
        `Failed to save import config: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    onError: (error) => {
      toast.error(
        `Failed to sync GitHub issues: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
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
    onError: (error) => {
      toast.error(
        `Failed to sync Jira issues: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
