import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings } from "lucide-react";
import type { ConnectionKey } from "@/types/bindings";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AccentBubbles } from "@/components/common/accent-bubbles/AccentBubbles";
import { ThemeToggle } from "@/components/common/theme-toggle/ThemeToggle";
import { GlobalAccentColorPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { WindowControls } from "@/components/layout/window-chrome/WindowControls";
import { SettingsPage } from "@/views/settings/settings-page/SettingsPage";
import { SshAuthModal } from "@/views/project-picker/ssh-auth-modal/SshAuthModal";
import type { AuthSubmission } from "@/views/project-picker/ssh-auth-modal/ssh-auth-utils";
import {
  connectionQueryKeys,
  dockerQueryKeys,
  useDockerConnections,
  useSshConnections,
  useWslConnections,
  wslQueryKeys,
} from "@/services/connection.service";
import { api } from "@/lib/tauri-utils";
import { getErrorMessage } from "@/lib/error-utils";
import { connectionKeyId, useHomeStore } from "@/store/homeStore";
import { AddConnectionPanel } from "./AddConnection";
import { AddProjectDialog } from "./AddProjectDialog";
import { ConnectionMenu } from "./ConnectionMenu";
import { ConnectionPanel } from "./ConnectionPanel";
import type { HomeConnection } from "./ConnectionPanel";
import { Hero } from "./Hero";
import { IntegrationsPanel } from "./IntegrationsPanel";
import type { ProjectCard } from "./ProjectTile";
import { VersionBadge } from "./VersionBadge";
import { attach, useConnectionLossEvents } from "./useConnectionActions";
import { useHomeSummaries } from "./useHomeSummaries";
import { useOpenProject } from "./useOpenProject";

const LOCAL: ConnectionKey = { type: "local" };

/** Every saved connection, This computer first. */
function useHomeConnections(): HomeConnection[] {
  const { data: ssh = [] } = useSshConnections();
  const { data: wsl = [] } = useWslConnections();
  const { data: docker = [] } = useDockerConnections();
  return useMemo(
    () => [
      { key: LOCAL, id: "local", name: "This computer", detail: "" },
      ...ssh.map((connection) => ({
        key: { type: "ssh", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "ssh", id: connection.id }),
        name: connection.display_name ?? connection.host,
        detail: `${connection.username}@${connection.host}`,
        ssh: connection,
      })),
      ...wsl.map((connection) => ({
        key: { type: "wsl", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "wsl", id: connection.id }),
        name: connection.display_name ?? connection.distro_name,
        detail: "WSL",
        wsl: connection,
      })),
      ...docker.map((connection) => ({
        key: { type: "docker", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "docker", id: connection.id }),
        name: connection.display_name ?? connection.container_name,
        detail: connection.image_name ?? "Container",
        docker: connection,
      })),
    ],
    [ssh, wsl, docker],
  );
}

/**
 * The screen Maestro opens on: every connection with the live state of its projects. It replaces
 * the project picker; see docs/home-dashboard/design.md.
 */
export function HomeView() {
  const queryClient = useQueryClient();
  const connections = useHomeConnections();
  const phases = useHomeStore((s) => s.phases);
  const attachedOrder = useHomeStore((s) => s.attachedOrder);
  const minimized = useHomeStore((s) => s.minimized);
  const toggleMinimized = useHomeStore((s) => s.toggleMinimized);
  const { openProject, openPath, opening, waitingOn, importing, dialogs } = useOpenProject();
  const [settingsFor, setSettingsFor] = useState<ConnectionKey | "app" | null>(null);
  const [addingTo, setAddingTo] = useState<HomeConnection | null>(null);
  const [signInFor, setSignInFor] = useState<HomeConnection | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useConnectionLossEvents();

  // Home attaches to This computer on its own, and to nothing else.
  useEffect(() => {
    if (!useHomeStore.getState().phases.local) void attach(LOCAL);
  }, []);

  const up = connections.filter((connection) => phases[connection.id]?.kind === "up");
  const summaries = useHomeSummaries(up.map((connection) => connection.key));

  // This computer, then the connections attached this session, then the rest; a panel being
  // signed in keeps its place until it is attached.
  const ordered = useMemo(() => {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    const attached = attachedOrder
      .filter((id) => id !== "local")
      .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const rest = connections.filter(
      (connection) => connection.id !== "local" && !attachedOrder.includes(connection.id),
    );
    return [connections[0], ...attached, ...rest];
  }, [connections, attachedOrder]);

  const cardsFor = (connection: HomeConnection): ProjectCard[] | null =>
    summaries.get(connection.id)?.projects ?? null;
  const allCards = up.flatMap((connection) => cardsFor(connection) ?? []);
  const totals = {
    working: allCards.reduce((sum, card) => sum + card.working, 0),
    needYou: allCards.filter((card) => card.needsYou).length,
    toReview: allCards.reduce((sum, card) => sum + card.review, 0),
  };

  const openCard = (connection: HomeConnection, card: ProjectCard) =>
    card.projectId !== null ? openProject(card.projectId) : openPath(card.path, connection.key);

  const removeConnection = async (connection: HomeConnection) => {
    if (connection.key.type === "ssh") await api.deleteSshConnection(connection.key.id);
    if (connection.key.type === "wsl") await api.deleteWslConnection(connection.key.id);
    if (connection.key.type === "docker") await api.deleteDockerConnection(connection.key.id);
    useHomeStore.getState().setPhase(connection.id, { kind: "idle" });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() }),
      queryClient.invalidateQueries({ queryKey: wslQueryKeys.connections() }),
      queryClient.invalidateQueries({ queryKey: dockerQueryKeys.connections() }),
    ]);
    toast.success(`${connection.name} removed`);
  };

  const changeSignIn = async (submission: AuthSubmission) => {
    const connection = signInFor;
    if (!connection || connection.key.type !== "ssh") return;
    const id = connection.key.id;
    setSigningIn(true);
    try {
      if (submission.method === "password")
        await api.connectSshWithPassword(id, submission.password, submission.savePassword);
      if (submission.method === "key-file")
        await api.connectSshWithKey(
          id,
          submission.keyPath,
          submission.passphrase ?? null,
          submission.savePassphrase,
        );
      if (submission.method === "agent") await api.connectSshWithAgent(id);
      setSignInFor(null);
      await queryClient.invalidateQueries({ queryKey: connectionQueryKeys.list() });
      await attach(connection.key);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-sm text-foreground">
      {/* The screen paints its own background, so these cannot sit behind it on a negative
          layer the way they do in the header — they go at z-0 and the content is raised. */}
      <span aria-hidden className="screen-gradient z-0" />
      <AccentBubbles variant="screen" className="z-0" />

      {/* No AppHeader here, so this strip is the window's drag region. */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-end gap-1 px-4"
      >
        <GlobalAccentColorPicker />
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => setSettingsFor("app")}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted/80 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted-foreground"
                aria-label="Settings"
              />
            }
          >
            <Settings />
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">Settings</p>
          </TooltipContent>
        </Tooltip>
        <WindowControls className="-mr-2 ml-1" />
      </div>

      <main className="relative z-10 mx-auto max-w-[1200px] px-12 pt-20 pb-14">
        <Hero working={totals.working} needYou={totals.needYou} toReview={totals.toReview} />
        <div className="mb-5 grid grid-cols-2 gap-5">
          <AddConnectionPanel />
          <IntegrationsPanel />
        </div>
        <div className="grid grid-cols-2 gap-5">
          {ordered.map((connection) => {
            const phase = phases[connection.id] ?? { kind: "idle" as const };
            const summary = summaries.get(connection.id);
            return (
              <ConnectionPanel
                key={connection.id}
                connection={
                  connection.id === "local" && summary?.hostname
                    ? { ...connection, detail: summary.hostname }
                    : connection
                }
                phase={phase}
                projects={cardsFor(connection)}
                runningAutomations={summary?.runningAutomations ?? 0}
                minimized={minimized.includes(connection.id)}
                onToggleMinimized={() => toggleMinimized(connection.id)}
                openingProject={opening}
                onOpenProject={(card) => void openCard(connection, card)}
                onAddProject={() => setAddingTo(connection)}
                menu={
                  <ConnectionMenu
                    connection={connection}
                    phase={phase}
                    projects={cardsFor(connection)}
                    server={summary?.server ?? null}
                    onSettings={() => setSettingsFor(connection.key)}
                    onChangeSignIn={() => setSignInFor(connection)}
                    onRemove={
                      connection.id === "local" ? undefined : () => removeConnection(connection)
                    }
                  />
                }
              />
            );
          })}
        </div>
        {(waitingOn || importing) && (
          <div className="home-pill fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-lg px-3 py-1.5 text-xs">
            {waitingOn
              ? `Waiting for Maestro on ${waitingOn}…`
              : "Moving this project's board to its server…"}
          </div>
        )}
      </main>

      <VersionBadge />

      <Dialog open={settingsFor !== null} onOpenChange={(open) => !open && setSettingsFor(null)}>
        {/* The close button defaults to `top-4`, which centres a 32px control against a 64px
            header — this one sits in a 48px strip, so it needs `top-2` to line up. */}
        <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl [&>[data-slot=dialog-close]]:top-2">
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <div className="min-h-0 flex-1">
            <SettingsPage
              headerPadEnd
              framed={false}
              connection={settingsFor === "app" || settingsFor === null ? undefined : settingsFor}
            />
          </div>
        </DialogContent>
      </Dialog>

      <AddProjectDialog
        connection={addingTo}
        onClose={() => setAddingTo(null)}
        onOpenPath={(path) => openPath(path, addingTo?.key ?? LOCAL)}
        onOpenProject={(projectId) => openProject(projectId)}
      />
      <SshAuthModal
        open={signInFor !== null}
        username={signInFor?.ssh?.username ?? ""}
        onSubmit={(submission) => void changeSignIn(submission)}
        onCancel={() => setSignInFor(null)}
        loading={signingIn}
      />
      {dialogs}
    </div>
  );
}
