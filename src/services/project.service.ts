import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "./ipc";
import type {
  Project,
  ProjectConfigResponse,
  ProjectConfigRequest,
  AppSettings,
} from "@/types/bindings";

/**
 * Project service providing type-safe operations for project management.
 * All project-related IPC calls are centralized here.
 */
const projectService = {
  /**
   * Get all projects
   */
  async getProjects(): Promise<Project[]> {
    return ipc.invoke<Project[]>("get_projects");
  },

  /**
   * Get project details by ID
   */
  async getProject(projectId: number): Promise<Project> {
    return ipc.invoke<Project>("get_project", { projectId });
  },

  /**
   * Create a new project
   */
  async createProject(name: string, path: string, description?: string): Promise<Project> {
    return ipc.invoke<Project>("create_project", {
      name,
      path,
      description: description || "",
    });
  },

  /**
   * Remove a project
   */
  async removeProject(projectId: number): Promise<void> {
    return ipc.invoke<void>("remove_project", { projectId });
  },

  /**
   * Get project configuration/settings
   */
  async getProjectSettings(projectId: number): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("get_project_settings", {
      projectId,
    });
  },

  /**
   * Update project configuration/settings
   */
  async updateProjectSettings(
    projectId: number,
    config: ProjectConfigRequest,
  ): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("update_project_settings", {
      projectId,
      config,
    });
  },

  /**
   * Save import configuration for a project
   */
  async saveImportConfig(projectId: number, importConfig: Record<string, unknown>): Promise<void> {
    return ipc.invoke<void>("save_import_config", {
      projectId,
      importConfig,
    });
  },

  /**
   * Get application settings (legacy name for compatibility)
   */
  async getSettings(): Promise<AppSettings> {
    return ipc.invoke<AppSettings>("get_settings");
  },

  /**
   * Get or create a project by path
   */
  async getOrCreateProject(path: string, description?: string): Promise<Project> {
    return ipc.invoke<Project>("get_or_create_project", {
      path,
      description: description || "",
    });
  },

  /**
   * Sync GitHub issues
   */
  async syncGithubIssues(
    projectId: number,
    owner: string,
    repo: string,
    token: string,
  ): Promise<{ imported_count: number; error_message?: string }> {
    return ipc.invoke<{ imported_count: number; error_message?: string }>("sync_github_issues", {
      projectId,
      owner,
      repo,
      token,
    });
  },

  /**
   * Sync Jira issues
   */
  async syncJiraIssues(
    projectId: number,
    host: string,
    email: string,
    token: string,
    jql: string,
  ): Promise<{ imported_count: number; error_message?: string }> {
    return ipc.invoke<{ imported_count: number; error_message?: string }>("sync_jira_issues", {
      projectId,
      host,
      email,
      token,
      jql,
    });
  },
};

/**
 * Query key factory for project-related queries
 * Ensures consistent cache invalidation across components
 */
const projectQueryKeys = {
  baseKey: ["projects"] as const,
  lists: () => [...projectQueryKeys.baseKey, "list"] as const,
  list: () => [...projectQueryKeys.lists()] as const,
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
    queryFn: () => projectService.getProjects(),
    staleTime: Infinity,
  });
}

/**
 * Query hook for fetching a single project by ID
 */
export function useProjectById(projectId: number) {
  return useQuery({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: () => projectService.getProject(projectId),
    staleTime: Infinity,
  });
}

/**
 * Query hook for fetching project settings/configuration
 */
export function useProjectSettings(projectId: number) {
  return useQuery({
    queryKey: projectQueryKeys.settingsDetail(projectId),
    queryFn: () => projectService.getProjectSettings(projectId),
    staleTime: Infinity,
  });
}

/**
 * Mutation hook for creating a new project
 */
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      name,
      path,
      description,
    }: {
      name: string;
      path: string;
      description?: string;
    }) => projectService.createProject(name, path, description),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists() });
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
    mutationFn: (projectId: number) => projectService.removeProject(projectId),
    onSuccess: (_data, projectId) => {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists() });
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
      projectService.updateProjectSettings(projectId, config),
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
    }) => projectService.saveImportConfig(projectId, importConfig),
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
    }) => projectService.syncGithubIssues(projectId, owner, repo, token),
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
    }) => projectService.syncJiraIssues(projectId, host, email, token, jql),
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
