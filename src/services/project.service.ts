import { ipc } from "./ipc";
import type {
  Project,
  ProjectConfigResponse,
  ProjectConfigRequest,
} from "@/types/bindings";

/**
 * Project service providing type-safe operations for project management.
 * All project-related IPC calls are centralized here.
 */
export const projectService = {
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
};
