import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  useCheckIsGitRepo,
  useCreateProject,
  useGitInitProject,
  useRequestProjectTakeover,
} from "@/services/project.service";
import { useSelectedProjectActions, applyProjectStartupTab } from "@/store/projectStore";
import type { ConnectionKey, Project } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import {
  getErrorMessage,
  importFailure,
  isProjectLockedError,
  projectLockHolder,
} from "@/lib/error-utils";
import { GitInitDialog } from "@/views/home/GitInitDialog";
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

/** The ids the git commands take, spread from a connection key. */
function connectionIds(connection: ConnectionKey) {
  return {
    connectionId: connection.type === "ssh" ? connection.id : null,
    wslConnectionId: connection.type === "wsl" ? connection.id : null,
    dockerConnectionId: connection.type === "docker" ? connection.id : null,
  };
}

/** The holder's server grants a takeover nobody answers after this long (`TAKEOVER_TIMEOUT`). */
const TAKEOVER_SECONDS = 10;

export interface OpenProjectOptions {
  /**
   * Switches the window to the project once it is ready, by calling `show`, wrapped in whatever
   * transition the caller plays. Without it the window switches straight away.
   */
  switchTo?: (project: Project, show: () => void) => Promise<unknown>;
  /** An open that ended without switching: it failed, or waits on a takeover or a git init. */
  onAbandon?: () => void;
}

/**
 * Opening a project from Home, whichever way it is reached: a tile, a folder, a clone or a new
 * repository. Takes the project's lock, primes its server (the first open after the upgrade moves
 * the board into it), applies the startup tab and switches the window to the project.
 *
 * A project held by another window offers a takeover; a folder that is not a git repository
 * offers to initialise one. `dialogs` renders both prompts and must be mounted by the caller.
 */
export function useOpenProject(options: OpenProjectOptions = {}) {
  const { setSelectedProject } = useSelectedProjectActions();
  const { mutateAsync: createProject } = useCreateProject();
  const { mutateAsync: checkIsGitRepo } = useCheckIsGitRepo();
  const { mutateAsync: gitInitProject } = useGitInitProject();
  const { mutateAsync: requestTakeover } = useRequestProjectTakeover();

  const [opening, setOpening] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [takeover, setTakeover] = useState<{ projectId: number; holder: string } | null>(null);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [gitInit, setGitInit] = useState<{ path: string; connection: ConnectionKey } | null>(null);
  const [gitInitLoading, setGitInitLoading] = useState(false);

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

  // The countdown to the holder's server taking the project away by itself.
  useEffect(() => {
    if (waitingOn === null) return;
    const timer = setInterval(() => setSecondsLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [waitingOn]);

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
    // The open took the project's lock before the import failed; Retry takes it again.
    void api.releaseActiveProjectLock().catch(console.error);
    toast.error(failure, {
      action: { label: "Retry", onClick: () => void openProject(projectId) },
    });
  };

  const openProject = async (projectId: number, knownGitRepo?: boolean) => {
    setOpening(projectId);
    try {
      const project = await api.openProject(projectId);
      const [isGitRepo] = await Promise.all([
        knownGitRepo ??
          checkIsGitRepo({
            path: project.path,
            connectionId: project.connection_id,
            wslConnectionId: project.wsl_connection_id,
            dockerConnectionId: project.docker_connection_id ?? null,
          }),
        primeProject(projectId),
        applyProjectStartupTab(project.id),
      ]);
      const show = () => setSelectedProject(project, isGitRepo);
      await (options.switchTo ? options.switchTo(project, show) : show());
    } catch (error) {
      options.onAbandon?.();
      if (isProjectLockedError(error)) {
        setTakeover({ projectId, holder: projectLockHolder(error) });
      } else {
        reportOpenFailure(projectId, error);
      }
    } finally {
      setOpening(null);
      setImporting(false);
    }
  };

  /** Open a folder this app may not know yet, registering it first. */
  const openPath = async (path: string, connection: ConnectionKey) => {
    try {
      const isGitRepo = await checkIsGitRepo({ path, ...connectionIds(connection) });
      if (!isGitRepo) {
        options.onAbandon?.();
        setGitInit({ path, connection });
        return;
      }
      const created = await createProject({ path, connection });
      await openProject(created.id, true);
    } catch (error) {
      options.onAbandon?.();
      toast.error(`Failed to open project: ${getErrorMessage(error)}`);
    }
  };

  const finishGitInit = async (initialise: boolean) => {
    if (!gitInit) return;
    const { path, connection } = gitInit;
    setGitInitLoading(true);
    try {
      if (initialise) await gitInitProject({ path, ...connectionIds(connection) });
      setGitInit(null);
      const created = await createProject({ path, connection });
      await openProject(created.id, initialise);
    } catch (error) {
      toast.error(
        initialise
          ? `Failed to initialize git: ${getErrorMessage(error)}`
          : `Failed to open project: ${getErrorMessage(error)}`,
      );
    } finally {
      setGitInitLoading(false);
    }
  };

  const confirmTakeover = async () => {
    if (!takeover) return;
    const { projectId, holder } = takeover;
    setSecondsLeft(TAKEOVER_SECONDS);
    setWaitingOn(holder);
    let granted = false;
    try {
      granted = await requestTakeover(projectId);
      if (!granted) toast.error(`Maestro on ${holder} kept the project`);
    } catch (error) {
      toast.error(`Takeover failed: ${getErrorMessage(error)}`);
    } finally {
      setWaitingOn(null);
      setTakeover(null);
    }
    if (granted) await openProject(projectId);
  };

  const dialogs = (
    <>
      <GitInitDialog
        open={gitInit !== null}
        onOpenChange={(open) => !open && setGitInit(null)}
        path={gitInit?.path ?? ""}
        onInitGit={() => void finishGitInit(true)}
        onSkip={() => void finishGitInit(false)}
        loading={gitInitLoading}
      />
      {/* The request cannot be withdrawn, so the dialog stays until the holder answers. */}
      <AlertDialog
        open={takeover !== null}
        onOpenChange={(open) => !open && waitingOn === null && setTakeover(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Project is open elsewhere</AlertDialogTitle>
            <AlertDialogDescription>
              Open in Maestro on {takeover?.holder}. Request takeover?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={waitingOn !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={waitingOn !== null}
              onClick={() => void confirmTakeover()}
              className="tabular-nums"
            >
              {waitingOn === null
                ? "Request takeover"
                : secondsLeft > 0
                  ? `Waiting for response · ${secondsLeft}s`
                  : "Taking over…"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return {
    openProject,
    openPath,
    /** The project being opened, for a spinner on its tile. */
    opening,
    /** The project's board is being moved into its server, which takes a moment. */
    importing,
    dialogs,
  };
}
