import { toast } from "sonner";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";
import { CloneProjectDialog } from "../clone-project-dialog/CloneProjectDialog";
import { CreateProjectDialog } from "../create-project-dialog/CreateProjectDialog";
import { PreflightModal } from "./PreflightModal";
import { useProjectPickerNavigation } from "@/hooks/useProjectPickerNavigation";
import {
  useRecentProjects,
  useProjectLocks,
  useCreateProject,
  useDeleteProject,
  useGitInitProject,
  useCheckIsGitRepo,
  useRequestProjectTakeover,
  connectionQueryKey,
} from "@/services/project.service";
import { useSelectedProjectActions, applyProjectStartupTab } from "@/store/projectStore";
import type { ConnectionKey } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import {
  getErrorMessage,
  importFailure,
  isProjectLockedError,
  projectLockHolder,
} from "@/lib/error-utils";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { Folder, Loader2, Container } from "lucide-react";
import { ConnectionHeader } from "../connection-list/ConnectionHeader";
import { WslConnectionHeader } from "./WslConnectionHeader";
import { FilePicker } from "../file-picker/FilePicker";
import { GitInitDialog } from "./GitInitDialog";
import { Dialog, DialogContent } from "@/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export function ProjectList() {
  const { activeConnection, preflightStatus } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();
  const activeConnectionKey: import("@/types/bindings").ConnectionKey =
    activeConnection?.dockerConnection
      ? { type: "docker", id: activeConnection.dockerConnection.id }
      : activeConnection?.wslConnection
        ? { type: "wsl", id: activeConnection.wslConnection.id }
        : activeConnection?.sshConnection
          ? { type: "ssh", id: activeConnection.sshConnection.id }
          : { type: "local" };
  const { data: recentProjects = [], isLoading: projectsLoading } =
    useRecentProjects(activeConnectionKey);
  const projectIds = useMemo(() => recentProjects.map((p) => p.id), [recentProjects]);
  const { data: locks = [] } = useProjectLocks(activeConnectionKey, projectIds);
  // This window's own project is not "locked" to it: a webview reload lands here still holding it.
  const lockHolders = useMemo(
    () => new Map(locks.filter((l) => !l.yours).map((l) => [l.project_id, l.holder_label])),
    [locks],
  );

  const [showFilePickerModal, setShowFilePickerModal] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [projectLoading, setLoading] = useState(false);
  const [takeover, setTakeover] = useState<{ projectId: number; holder: string } | null>(null);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const setProjectLoading = (loading: boolean) => {
    setLoading(loading);
    if (!loading) setImporting(false);
  };
  const { setSelectedProject } = useSelectedProjectActions();
  const { mutateAsync: requestTakeover } = useRequestProjectTakeover();

  // The first open after the upgrade moves the project's board from this app into its server.
  // Another window opening another project emits the same event, so only this one's counts.
  const openingId = useRef<number | null>(null);
  useEffect(() => {
    const unlisten = listen<number>("project-importing", ({ payload }) => {
      if (payload === openingId.current) setImporting(true);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Any other prime failure is benign, but a failed import keeps the project closed.
  const primeProject = (projectId: number) => {
    openingId.current = projectId;
    return api.primeProjectServer(projectId).catch((error: unknown) => {
      if (importFailure(error) !== null) throw error;
    });
  };

  const reportOpenFailure = (projectId: number, error: unknown) => {
    const failure = importFailure(error);
    if (failure === null) {
      toast.error(`Failed to open project: ${getErrorMessage(error)}`);
      return;
    }
    toast.error(failure, {
      action: { label: "Retry", onClick: () => void handleProjectClick(projectId) },
    });
  };

  const { mutateAsync: createProject } = useCreateProject();
  const { mutate: removeProject } = useDeleteProject(connectionQueryKey(activeConnectionKey));
  const { mutateAsync: gitInitProject } = useGitInitProject();
  const { mutateAsync: checkIsGitRepo } = useCheckIsGitRepo();

  const [pendingSelection, setPendingSelection] = useState<{
    path: string;
    connectionId?: number;
    wslConnectionId?: number;
    dockerConnectionId?: number;
  } | null>(null);
  const [showGitInitDialog, setShowGitInitDialog] = useState(false);
  const [gitInitLoading, setGitInitLoading] = useState(false);

  const finalizeProjectOpen = async (
    selectedPath: string,
    connectionId?: number,
    wslConnectionId?: number,
    dockerConnectionId?: number,
    isGitRepo = true,
  ) => {
    const connection: ConnectionKey =
      dockerConnectionId != null
        ? { type: "docker", id: dockerConnectionId }
        : wslConnectionId != null
          ? { type: "wsl", id: wslConnectionId }
          : connectionId != null
            ? { type: "ssh", id: connectionId }
            : { type: "local" };
    const created = await createProject({ path: selectedPath, connection });
    let project;
    try {
      project = await api.openProject(created.id);
    } catch (error) {
      if (!isProjectLockedError(error)) throw error;
      setShowFilePickerModal(false);
      setTakeover({ projectId: created.id, holder: projectLockHolder(error) });
      return;
    }
    try {
      await Promise.all([primeProject(created.id), applyProjectStartupTab(project.id)]);
    } catch (error) {
      setShowFilePickerModal(false);
      reportOpenFailure(created.id, error);
      return;
    }
    setSelectedProject(project, isGitRepo);
    setShowFilePickerModal(false);
  };

  const handleProjectSelect = async (
    selectedPath: string,
    connectionId?: number,
    wslConnectionId?: number,
    dockerConnectionId?: number,
  ) => {
    setProjectLoading(true);
    try {
      const isGitRepo = await checkIsGitRepo({
        path: selectedPath,
        connectionId: connectionId ?? null,
        wslConnectionId: wslConnectionId ?? null,
        dockerConnectionId: dockerConnectionId ?? null,
      });
      if (isGitRepo) {
        await finalizeProjectOpen(selectedPath, connectionId, wslConnectionId, dockerConnectionId);
      } else {
        setPendingSelection({
          path: selectedPath,
          connectionId,
          wslConnectionId,
          dockerConnectionId,
        });
        setShowGitInitDialog(true);
      }
    } catch (error) {
      toast.error(`Failed to open project: ${getErrorMessage(error)}`);
    } finally {
      setProjectLoading(false);
    }
  };

  const handleGitInit = async () => {
    if (!pendingSelection) return;
    setGitInitLoading(true);
    try {
      await gitInitProject({
        path: pendingSelection.path,
        connectionId: pendingSelection.connectionId ?? null,
        wslConnectionId: pendingSelection.wslConnectionId ?? null,
        dockerConnectionId: pendingSelection.dockerConnectionId ?? null,
      });
      setShowGitInitDialog(false);
      setProjectLoading(true);
      await finalizeProjectOpen(
        pendingSelection.path,
        pendingSelection.connectionId,
        pendingSelection.wslConnectionId,
        pendingSelection.dockerConnectionId,
      );
    } catch (error) {
      toast.error(`Failed to initialize git: ${String(error)}`);
    } finally {
      setGitInitLoading(false);
      setProjectLoading(false);
      setPendingSelection(null);
    }
  };

  const handleSkipGitInit = async () => {
    if (!pendingSelection) return;
    setShowGitInitDialog(false);
    setProjectLoading(true);
    try {
      await finalizeProjectOpen(
        pendingSelection.path,
        pendingSelection.connectionId,
        pendingSelection.wslConnectionId,
        pendingSelection.dockerConnectionId,
        false,
      );
    } catch (error) {
      toast.error(`Failed to open project: ${getErrorMessage(error)}`);
    } finally {
      setProjectLoading(false);
      setPendingSelection(null);
    }
  };

  const handleProjectClick = async (projectId: number) => {
    setProjectLoading(true);
    try {
      const project = await api.openProject(projectId);
      const [isGitRepo] = await Promise.all([
        checkIsGitRepo({
          path: project.path,
          connectionId: project.connection_id,
          wslConnectionId: project.wsl_connection_id,
          dockerConnectionId: project.docker_connection_id ?? null,
        }),
        primeProject(projectId),
        applyProjectStartupTab(project.id),
      ]);
      setSelectedProject(project, isGitRepo);
    } catch (error) {
      if (isProjectLockedError(error)) {
        setTakeover({ projectId, holder: projectLockHolder(error) });
      } else {
        reportOpenFailure(projectId, error);
      }
    } finally {
      setProjectLoading(false);
    }
  };

  const handleTakeover = async () => {
    if (!takeover) return;
    const { projectId, holder } = takeover;
    setTakeover(null);
    setProjectLoading(true);
    setWaitingOn(holder);
    let granted = false;
    try {
      granted = await requestTakeover(projectId);
      if (!granted) toast.error(`Maestro on ${holder} kept the project`);
    } catch (error) {
      toast.error(`Takeover failed: ${getErrorMessage(error)}`);
    } finally {
      setWaitingOn(null);
      setProjectLoading(false);
    }
    if (granted) await handleProjectClick(projectId);
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
            ) : activeConnection.type === "wsl" && activeConnection.wslConnection ? (
              <WslConnectionHeader
                connectionId={activeConnection.wslConnection.id}
                onDelete={navigateToConnections}
              />
            ) : activeConnection.type === "docker" && activeConnection.dockerConnection ? (
              <>
                <Container className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">
                  {activeConnection.dockerConnection.display_name ??
                    activeConnection.dockerConnection.container_name}
                </h2>
              </>
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
              <span className="text-sm text-muted-foreground">
                {waitingOn
                  ? `Waiting for Maestro on ${waitingOn}…`
                  : importing
                    ? "Moving this project's board to its server…"
                    : "Warming up…"}
              </span>
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
                    lockedBy={lockHolders.get(project.id)}
                  />
                ))}
              </ul>
            ))}
        </ProjectsListLayout>

        {showFailureModal && <PreflightModal />}

        <AlertDialog
          open={takeover !== null}
          onOpenChange={(open) => {
            if (!open) setTakeover(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Project is open elsewhere</AlertDialogTitle>
              <AlertDialogDescription>
                Open in Maestro on {takeover?.holder}. Request takeover?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleTakeover()}>
                Request takeover
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={showFilePickerModal} onOpenChange={setShowFilePickerModal}>
          <DialogContent className="h-150 md:max-w-4xl p-0 flex flex-col [&>button:hover]:text-accent">
            <FilePicker
              connection={activeConnection?.sshConnection}
              wslConnection={activeConnection?.wslConnection}
              dockerConnection={activeConnection?.dockerConnection}
              onProjectSelect={handleProjectSelect}
              loading={projectLoading}
            />
          </DialogContent>
        </Dialog>

        <CloneProjectDialog
          open={showCloneDialog}
          onOpenChange={setShowCloneDialog}
          connection={activeConnection?.sshConnection ?? null}
          wslConnection={activeConnection?.wslConnection ?? null}
          dockerConnection={activeConnection?.dockerConnection ?? null}
        />

        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          connection={activeConnection?.sshConnection ?? null}
          wslConnection={activeConnection?.wslConnection ?? null}
          dockerConnection={activeConnection?.dockerConnection ?? null}
        />

        <GitInitDialog
          open={showGitInitDialog}
          onOpenChange={(open) => {
            if (!open) {
              setShowGitInitDialog(false);
              setPendingSelection(null);
            }
          }}
          path={pendingSelection?.path ?? ""}
          onInitGit={handleGitInit}
          onSkip={handleSkipGitInit}
          loading={gitInitLoading}
        />
      </>
    )
  );
}
