import { toast } from "sonner";
import { ProjectListItem } from "@/components/project-picker/ProjectListItem";
import { ProjectsListLayout } from "@/components/project-picker/ProjectsListLayout";
import { CloneProjectDialog } from "@/components/project-picker/CloneProjectDialog";
import { CreateProjectDialog } from "@/components/project-picker/CreateProjectDialog";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import {
  useRecentProjects,
  useProjectLocks,
  useCreateProject,
  useRemoveProject,
  useGitInitProject,
} from "@/services/project.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { Folder } from "lucide-react";
import { ConnectionHeader } from "@/components/project-picker/ConnectionHeader";
import { FilePicker } from "@/components/project-picker/FilePicker";
import { Dialog, DialogContent } from "@/ui/dialog";
import { useMemo, useState } from "react";

/**
 * Unified component for displaying and managing project lists.
 * Handles both local and remote (SSH) projects.
 *
 */
export function ProjectList() {
  const { activeConnection } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();
  const { data: recentProjects = [], isLoading: loading } = useRecentProjects(
    activeConnection?.sshConnection?.id,
  );
  const projectIds = useMemo(() => recentProjects.map((p) => p.id), [recentProjects]);
  const { data: lockedProjectIds = [] } = useProjectLocks(projectIds);
  const lockedSet = useMemo(() => new Set(lockedProjectIds), [lockedProjectIds]);

  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const { setSelectedProject } = useSelectedProjectActions();

  // Initialize service hooks
  const { mutateAsync: createProject } = useCreateProject();
  const { mutate: removeProject } = useRemoveProject(activeConnection?.id);
  const { mutateAsync: gitInitProject } = useGitInitProject();

  /**
   * Handle project selection from FilePicker.
   * Auto-initializes git silently before creating the project for local paths.
   */
  const handleProjectSelect = async (selectedPath: string, connectionId?: number) => {
    setProjectLoading(true);
    try {
      // Auto-init git if needed (silently — IPC is a no-op if .git already exists)
      // Only for local projects (connectionId undefined/null means local)
      if (!connectionId) {
        await gitInitProject({ path: selectedPath, connectionId: null });
      }
      const created = await createProject({
        path: selectedPath,
        connectionId: connectionId ?? null,
      });
      // Acquire project lock via open_project (create_project does not lock)
      const project = await api.openProject(created.id);
      setSelectedProject(project);
      setShowFilePickerModal(false);
    } catch (error) {
      const msg = String(error);
      if (msg.includes("PROJECT_LOCKED:")) {
        toast.error("Project already open in another Maestro instance");
      } else {
        toast.error(`Failed to open project: ${msg}`);
      }
    } finally {
      setProjectLoading(false);
    }
  };

  const handleProjectClick = async (projectId: number) => {
    setProjectLoading(true);
    try {
      const project = await api.openProject(projectId);
      setSelectedProject(project);
    } catch (error) {
      const msg = String(error);
      if (msg.includes("PROJECT_LOCKED:")) {
        toast.error("Project already open in another Maestro instance");
      } else {
        toast.error(`Failed to open project: ${msg}`);
      }
    } finally {
      setProjectLoading(false);
    }
  };

  const handleRemoveProject = async (projectId: number) => {
    removeProject(projectId);
    toast.success("Project removed from recent list");
  };

  return (
    activeConnection && (
      <>
        <ProjectsListLayout
          headerContent={
            activeConnection.type === "ssh" && activeConnection.sshConnection ? (
              <ConnectionHeader
                connectionId={activeConnection.sshConnection.id}
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
          onCloneClick={() => setShowCloneDialog(true)}
          onCreateClick={() => setShowCreateDialog(true)}
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
                  locked={lockedSet.has(project.id)}
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

        {/* Clone Project Dialog */}
        <CloneProjectDialog
          open={showCloneDialog}
          onOpenChange={setShowCloneDialog}
          connection={activeConnection?.sshConnection ?? null}
        />

        {/* Create Project Dialog */}
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          connection={activeConnection?.sshConnection ?? null}
        />
      </>
    )
  );
}
