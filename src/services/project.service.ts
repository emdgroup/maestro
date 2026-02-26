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
export const projectService = {
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
  async createProject(
    name: string,
    path: string,
    description?: string
  ): Promise<Project> {
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
    config: ProjectConfigRequest
  ): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("update_project_settings", {
      projectId,
      config,
    });
  },

  /**
   * Save import configuration for a project
   */
  async saveImportConfig(
    projectId: number,
    importConfig: Record<string, unknown>
  ): Promise<void> {
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
  async getOrCreateProject(
    path: string,
    description?: string
  ): Promise<Project> {
    return ipc.invoke<Project>("get_or_create_project", {
      path,
      description: description || "",
    });
  },
};

/**
 * Query key factory for project-related queries
 * Ensures consistent cache invalidation across components
 */
export const projectQueryKeys = {
  all: ["projects"] as const,
  lists: () => [...projectQueryKeys.all, "list"] as const,
  list: () => [...projectQueryKeys.lists()] as const,
  details: () => [...projectQueryKeys.all, "detail"] as const,
  detail: (id: number) => [...projectQueryKeys.details(), id] as const,
  settings: () => [...projectQueryKeys.all, "settings"] as const,
  settingsDetail: (projectId: number) => [...projectQueryKeys.settings(), projectId] as const,
};

/**
 * Query hook for fetching all projects
 */
export function useProjectsQuery() {
  return useQuery({
    queryKey: projectQueryKeys.list(),
    queryFn: () => projectService.getProjects(),
    staleTime: 300000, // 5 minutes—projects rarely change
    refetchOnWindowFocus: true,
  });
}

/**
 * Query hook for fetching a single project by ID
 */
export function useProjectQuery(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.detail(projectId!),
    queryFn: () => projectService.getProject(projectId!),
    enabled: projectId !== null,
    staleTime: 300000, // 5 minutes
  });
}

/**
 * Query hook for fetching project settings/configuration
 */
export function useProjectSettingsQuery(projectId: number | null) {
  return useQuery({
    queryKey: projectQueryKeys.settingsDetail(projectId!),
    queryFn: () => projectService.getProjectSettings(projectId!),
    enabled: projectId !== null,
    staleTime: 300000, // 5 minutes
  });
}

/**
 * Mutation hook for creating a new project
 */
export function useCreateProjectMutation() {
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
      queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists() });
    },
    onError: (error) => {
      toast.error(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for removing a project
 */
export function useRemoveProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: number) => projectService.removeProject(projectId),
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({ queryKey: projectQueryKeys.lists() });
      queryClient.invalidateQueries({ queryKey: projectQueryKeys.detail(projectId) });
    },
    onError: (error) => {
      toast.error(`Failed to remove project: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for updating project settings
 */
export function useUpdateProjectSettingsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      config,
    }: {
      projectId: number;
      config: ProjectConfigRequest;
    }) => projectService.updateProjectSettings(projectId, config),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(variables.projectId),
      });
    },
    onError: (error) => {
      toast.error(`Failed to update project settings: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/**
 * Mutation hook for saving import configuration
 */
export function useSaveImportConfigMutation() {
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
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(variables.projectId),
      });
    },
    onError: (error) => {
      toast.error(`Failed to save import config: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
