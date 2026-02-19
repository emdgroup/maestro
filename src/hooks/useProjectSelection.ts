import { useState, useCallback } from "react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { Connection } from "../components/ConnectionList";

interface UseProjectSelectionParams {
  activeConnection: Connection | null;
  onProjectSelected: (path: string) => void;
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
    async (path: string) => {
      console.log(`Opening project: ${path}`);
      setLoading(true);
      try {
        onProjectSelected(path);
      } catch (error) {
        toast.error(`Failed to open project: ${error}`);
      } finally {
        setLoading(false);
      }
    },
    [onProjectSelected]
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
        if (activeConnection.type === "local") {
          // For local, just open the path directly
          console.log(`Opening local project at: ${selectedPath}`);
          onProjectSelected(selectedPath);
        } else {
          // For remote, create remote project
          if (!activeConnection.sshConnection) {
            toast.error("No active SSH connection");
            return;
          }

          const sshConn = activeConnection.sshConnection;
          console.log(`Creating remote project at: ${selectedPath}`);

          // Parse auth method from string
          const authMethod = JSON.parse(sshConn.auth_method);

          // Create SSH config (use snake_case for Rust struct compatibility)
          const sshConfig = {
            host: sshConn.host,
            port: sshConn.port,
            username: sshConn.username,
            auth_method: authMethod,
            remote_path: selectedPath,
          };

          // Create remote project (pass connectionId to reuse existing session)
          const project = await safeInvoke<{ path: string }>("create_project", {
            name: `${sshConn.host}:${selectedPath}`,
            path: selectedPath,
            isRemote: true,
            sshConfig: sshConfig,
            connectionId: sshConn.id,
          });

          console.log(`Remote project created: ${project.path}`);
          toast.success(`Remote project created at ${selectedPath}`);

          // Open the project
          onProjectSelected(project.path);
        }
      } catch (error) {
        toast.error(`Failed to open project: ${error}`);
        setLoading(false);
      }
    },
    [activeConnection, onProjectSelected]
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
    [refetchRecentProjects, onRecentProjectsChanged]
  );

  return {
    loading,
    handleProjectClick,
    handleProjectSelect,
    handleRemoveRecentProject,
  };
}
