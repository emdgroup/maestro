import { useState, useCallback } from "react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { Connection } from "../components/ConnectionList";
import { Project } from "../../src-tauri/bindings/Project.ts";

interface UseProjectSelectionParams {
  activeConnection: Connection | null;
  onProjectSelected: (project: Project) => void;
  onRecentProjectsChanged?: () => void;
  refetchRecentProjects: () => Promise<void>;
}

/**
 * Custom hook for managing project selection and opening.
 *
 * Handles:
 * - Opening local projects directly
 * - Creating remote projects with SSH configuration
 * - Removing projects from recent list
 * - Coordinating with parent callbacks
 *
 * @param params - Configuration parameters including callbacks and active connection
 * @returns Project selection handlers and loading state
 */
export function useProjectSelection({
  activeConnection,
  onProjectSelected,
  onRecentProjectsChanged,
  refetchRecentProjects,
}: UseProjectSelectionParams) {
  const [loading, setLoading] = useState(false);

  /**
   * Handle clicking on an existing project (local or remote)
   * Opens the project directly
   */
  const handleProjectClick = useCallback(
    async (projectId: number) => {
      setLoading(true);
      try {
        const project = await safeInvoke<Project>("get_project", {
          projectId,
        });
        onProjectSelected(project);
      } catch (error) {
        toast.error(`Failed to open project: ${error}`);
      } finally {
        setLoading(false);
      }
    },
    [onProjectSelected],
  );

  /**
   * Handle project selection from file picker
   * For local: opens directly
   * For remote: creates remote project with SSH config
   */
  const handleProjectSelect = useCallback(
    async (selectedPath: string) => {
      if (!activeConnection) {
        toast.error("No active connection");
        return;
      }
      setLoading(true);
      try {
        if (activeConnection.type === "ssh") {
          // Remote: require connection_id (enforces authentication)
          if (!activeConnection.sshConnection?.id) {
            toast.error("SSH not authenticated");
            return;
          }
        }
        const project = await safeInvoke<Project>("create_project", {
          projectPath: selectedPath,
          connectionId: activeConnection?.sshConnection?.id,
        });
        onProjectSelected(project);
      } catch (error) {
        toast.error(`Failed to open project: ${error}`);
      } finally {
        setLoading(false);
      }
    },
    [activeConnection, onProjectSelected],
  );

  /**
   * Handle removing a project from the recent list
   */
  const handleRemoveRecentProject = useCallback(
    async (path: string) => {
      try {
        await safeInvoke("remove_recent_project", { path });
        // Refresh the recent projects list
        await refetchRecentProjects();
        // Notify parent to refetch its recent projects list
        onRecentProjectsChanged?.();
        toast.success("Project removed from recent list");
      } catch (error) {
        toast.error(`Failed to remove project: ${error}`);
      }
    },
    [refetchRecentProjects, onRecentProjectsChanged],
  );

  return {
    loading,
    handleProjectClick,
    handleProjectSelect,
    handleRemoveRecentProject,
  };
}
