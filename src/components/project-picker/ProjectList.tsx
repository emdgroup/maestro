import { toast } from "sonner";
import { ProjectListItem, ProjectsListLayout } from "@/components";
import { useProjectPickerNavigation } from "@/utils/hooks";
import { useRecentProjects, useCreateProject, useProjectById, useRemoveProject } from "@/services";
import { useSelectedProjectActions } from "@/store/projectStore";
import { useConnectionContext } from "@/contexts/ConnectionContext.tsx";
import { Folder } from "lucide-react";
import { ConnectionHeader, FilePicker } from "@/components/project-picker";
import { Dialog, DialogContent } from "@/ui/dialog.tsx";
import { useState } from "react";

/**
 * Unified component for displaying and managing project lists.
 * Handles both local and remote (SSH) projects.
 *
 * Replaces LocalProjectsList and RemoteProjectsList with a single implementation.
 */
export function ProjectList() {
  const { activeConnection, setActiveConnection } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();
  const {
    data: recentProjects = [],
    isLoading: loading,
    refetch,
  } = useRecentProjects(activeConnection?.sshConnection?.id);
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const { setSelectedProject } = useSelectedProjectActions();

  // Initialize service hooks
  const createProjectMutation = useCreateProject();
  const removeProjectMutation = useRemoveProject();

  /**
   * Handle project selection from FilePicker
   * Creates project in database and sets it as selected in store
   */
  const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
    setProjectLoading(true);
    try {
      const result = await createProjectMutation.mutateAsync({
        path: selectedPath,
        connectionId: connectionId ?? 0,
      });
      setSelectedProject(result);
      setShowFilePickerModal(false);
    } catch (error) {
      // Error toast is handled by the mutation hook
    } finally {
      setProjectLoading(false);
    }
  };

  const handleProjectClick = (projectId: number) => {
    // Find the project from the recent list (already cached)
    const project = recentProjects.find((p) => p.id === projectId);
    if (project) {
      setSelectedProject(project);
    } else {
      toast.error("Project not found in recent list");
    }
  };

  const handleRemoveProject = async (projectId: number) => {
    try {
      await removeProjectMutation.mutateAsync(projectId);
      await refetch();
      toast.success("Project removed from recent list");
    } catch (error) {
      // Error toast is handled by the mutation hook
    }
  };

  const handleConnectionRename = (displayName: string) => {
    if (activeConnection) {
      setActiveConnection({ ...activeConnection, displayName });
    }
  };

  return (
    activeConnection && (
      <>
        <ProjectsListLayout
          headerContent={
            activeConnection.type === "ssh" && activeConnection.sshConnection ? (
              <ConnectionHeader
                connection={activeConnection.sshConnection}
                onEditName={handleConnectionRename}
                onDelete={navigateToConnections}
              />
            ) : (
              <>
                <Folder className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Local</h2>
              </>
            )
          }
          onBack={navigateToConnections}
          onSelectNewClick={() => setShowFilePickerModal(true)}
          loading={loading}
        >
          {recentProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No recent projects</p>
          ) : (
            <ul className="space-y-2">
              {recentProjects.map((project) => (
                <ProjectListItem
                  key={project.id}
                  path={project.path}
                  onClick={() => handleProjectClick(project.id)}
                  onRemove={() => handleRemoveProject(project.id)}
                  disabled={loading}
                />
              ))}
            </ul>
          )}
        </ProjectsListLayout>
        {/* File Picker Modal (Local or Remote) */}
        <Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
          <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
            <FilePicker
              connection={activeConnection?.sshConnection}
              onProjectSelect={handleProjectSelect}
              loading={projectLoading}
            />
          </DialogContent>
        </Dialog>
      </>
    )
  );
}
