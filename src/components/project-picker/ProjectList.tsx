import { toast } from "sonner";
import { ProjectListItem } from "@/components/project-picker/ProjectListItem";
import { ProjectsListLayout } from "@/components/project-picker/ProjectsListLayout";
import { CloneProjectDialog } from "@/components/project-picker/CloneProjectDialog";
import { CreateProjectDialog } from "@/components/project-picker/CreateProjectDialog";
import { PreflightModal } from "@/components/project-picker/PreflightModal";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import {
  useRecentProjects,
  useProjectLocks,
  useCreateProject,
  useRemoveProject,
  useGitInitProject,
} from "@/services/project.service";
import { useSelectedProjectActions } from "@/store/projectStore";
import type { ConnectionKey } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { Folder, Loader2 } from "lucide-react";
import { ConnectionHeader } from "@/components/project-picker/ConnectionHeader";
import { FilePicker } from "@/components/project-picker/FilePicker";
import { Dialog, DialogContent } from "@/ui/dialog";
import { useMemo, useState } from "react";

export function ProjectList() {
  const { activeConnection, preflightStatus } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();
  const { data: recentProjects = [], isLoading: projectsLoading } = useRecentProjects(
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

  const { mutateAsync: createProject } = useCreateProject();
  const { mutate: removeProject } = useRemoveProject(activeConnection?.id);
  const { mutateAsync: gitInitProject } = useGitInitProject();

  const handleProjectSelect = async (
    selectedPath: string,
    connectionId?: number,
    wslConnectionId?: number,
  ) => {
    setProjectLoading(true);
    try {
      const connection: ConnectionKey = wslConnectionId != null
        ? { type: "wsl", id: wslConnectionId }
        : connectionId != null
          ? { type: "ssh", id: connectionId }
          : { type: "local" };
      if (connection.type === "local") {
        await gitInitProject({ path: selectedPath, connectionId: null });
      }
      const created = await createProject({ path: selectedPath, connection });
      const project = await api.openProject(created.id);
      try {
        await api.primeProjectServer(created.id);
      } catch {
        // Warmup failure is non-fatal — agent cache won't be pre-populated
      }
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
      try {
        await api.primeProjectServer(projectId);
      } catch {
        // Warmup failure is non-fatal — agent cache won't be pre-populated
      }
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

  const isChecking = preflightStatus === "checking";
  const showProjects = preflightStatus === "passed" || preflightStatus === "failed-ignored";
  const showFailureModal = preflightStatus === "failed";
  const loading = isChecking || projectsLoading || projectLoading;

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
          {isChecking && (
            <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Checking environment…</span>
            </div>
          )}
          {projectLoading && (
            <div className="flex flex-col items-center justify-center h-full gap-3 py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Warming up…</span>
            </div>
          )}
          {!projectLoading &&
            showProjects &&
            (recentProjects.length === 0 ? (
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
            ))}
        </ProjectsListLayout>

        {showFailureModal && <PreflightModal />}

        <Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
          <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
            <FilePicker
              connection={activeConnection?.sshConnection}
              wslConnection={activeConnection?.wslConnection}
              onProjectSelect={handleProjectSelect}
              loading={projectLoading}
            />
          </DialogContent>
        </Dialog>

        <CloneProjectDialog
          open={showCloneDialog}
          onOpenChange={setShowCloneDialog}
          connection={activeConnection?.sshConnection ?? null}
        />

        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          connection={activeConnection?.sshConnection ?? null}
        />
      </>
    )
  );
}
