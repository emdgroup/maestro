import { toast } from "sonner";
import { projectService } from "@/services";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";
import { useRecentProjects } from "@/utils/hooks";
import { useSelectedProjectActions } from "@/store/projectStore";
import { useConnectionContext } from "@/contexts/ConnectionContext.tsx";
import { Folder } from "lucide-react";
import { ConnectionHeader, FilePicker } from "@/components/project-picker";
import { Dialog, DialogContent } from "@/components/ui/dialog.tsx";
import { useState } from "react";
import { useProjectPickerNavigation } from "@/utils/hooks";

/**
 * Unified component for displaying and managing project lists.
 * Handles both local and remote (SSH) projects.
 *
 * Replaces LocalProjectsList and RemoteProjectsList with a single implementation.
 */
export function ProjectList() {
  const { activeConnection, setActiveConnection } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();
  const { recentProjects, loading, refetch } = useRecentProjects(
    activeConnection?.sshConnection?.id,
  );
  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const { setSelectedProject } = useSelectedProjectActions();

  /**
   * Handle project selection from FilePicker
   * Creates project in database and sets it as selected in store
   */
  const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
    setProjectLoading(true);
    try {
      const project = await projectService.createProject(
        selectedPath,
        selectedPath,
        connectionId?.toString()
      );
      setSelectedProject(project);
      setShowFilePickerModal(false);
    } catch (error) {
      toast.error(`Failed to open project: ${error}`);
    } finally {
      setProjectLoading(false);
    }
  };

  const handleProjectClick = async (projectId: number) => {
    try {
      const project = await projectService.getProject(projectId);
      setSelectedProject(project);
    } catch (error) {
      toast.error(`Failed to open project: ${error}`);
    }
  };

  const handleRemoveProject = async (projectId: number) => {
    try {
      await projectService.removeProject(projectId);
      await refetch();
      toast.success("Project removed from recent list");
    } catch (error) {
      toast.error(`Failed to remove project: ${error}`);
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
