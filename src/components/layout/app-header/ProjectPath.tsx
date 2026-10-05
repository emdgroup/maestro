import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, House, Loader2, Lock, Plus } from "lucide-react";
import type { Project } from "@/types/bindings";
import { cn } from "@/lib/utils";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { getErrorMessage } from "@/lib/error-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useSelectedProjectActions } from "@/store/projectStore";
import { connectionKeyId, projectKey, useHomeStore } from "@/store/homeStore";
import type { ConnectionPhase } from "@/store/homeStore";
import { AddProjectDialog } from "@/views/home/AddProjectDialog";
import { CONNECTION_ICONS } from "@/views/home/ConnectionPanel";
import type { HomeConnection } from "@/views/home/ConnectionPanel";
import { displayPath, projectStatus } from "@/views/home/ProjectTile";
import type { ProjectCard } from "@/views/home/ProjectTile";
import { SshAuthModal } from "@/views/home/ssh-auth-modal/SshAuthModal";
import type { AuthSubmission } from "@/views/home/ssh-auth-modal/ssh-auth-utils";
import { attach, connect, signInWith } from "@/views/home/useConnectionActions";
import { useHomeConnections } from "@/views/home/useHomeConnections";
import { useHomeSummaries } from "@/views/home/useHomeSummaries";
import { useOpenProject } from "@/views/home/useOpenProject";
import {
  shrinkToHome,
  slideBack,
  slideOut,
  tileBox,
  whenSlidOut,
} from "@/components/layout/project-transition/projectTransition";

const segment =
  "flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs outline-none transition-colors hover:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] data-popup-open:bg-foreground/[0.08]";
const row =
  "flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-xs outline-none select-none data-highlighted:bg-foreground/[0.07]";
const amber = "text-amber-600 dark:text-amber-400";

function Slash() {
  return <span className="text-[13px] text-muted-foreground/50 select-none">/</span>;
}

function Panel({
  children,
  className,
  submenu = false,
}: {
  children: ReactNode;
  className?: string;
  submenu?: boolean;
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="z-50 outline-none"
        side={submenu ? "right" : "bottom"}
        align="start"
        sideOffset={submenu ? 10 : 6}
        alignOffset={submenu ? -7 : 0}
      >
        <Menu.Popup
          className={cn(
            "home-pop-strong max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-[14px] p-1.5 text-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function Separator() {
  return <Menu.Separator className="mx-1 my-1.5 h-px bg-foreground/[0.08]" />;
}

/** Needs you first, then working, idle and quiet, as Home's chips sort. */
function byStatus(cards: ProjectCard[]) {
  return [...cards].sort((a, b) => projectStatus(a).rank - projectStatus(b).rank);
}

/** The one line a tile shows under its name. */
function context(card: ProjectCard): ReactNode {
  if (card.blockingPrompt) return <span className={amber}>{card.blockingPrompt}</span>;
  if (card.runningAutomation) return `${card.runningAutomation} running`;
  if (card.holder) return `Open on ${card.holder}`;
  return null;
}

function counts(card: ProjectCard) {
  const parts = [
    card.working && `${card.working} working`,
    card.review && `${card.review} review`,
    card.queued && `${card.queued} queued`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing queued";
}

function StatusWord({
  card,
  opening,
  current,
}: {
  card: ProjectCard;
  opening: boolean;
  current: boolean;
}) {
  if (opening) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  if (current) return <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2.4} />;
  const status = projectStatus(card);
  return (
    <span className={cn("shrink-0 text-[11px] font-medium", status.className)}>{status.label}</span>
  );
}

function Count({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <span>
      <b
        className={cn("font-semibold tabular-nums", value ? className : "text-muted-foreground/50")}
      >
        {value}
      </b>{" "}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function phaseLine(phase: ConnectionPhase, cards: ProjectCard[] | null) {
  switch (phase.kind) {
    case "up":
      return cards ? `${cards.length} ${cards.length === 1 ? "project" : "projects"}` : "Connected";
    case "connecting":
      return "Connecting…";
    case "signin":
      return "Needs a password";
    case "failed":
      return "Could not connect";
    default:
      return "Not connected";
  }
}

interface ConnectionEntryProps {
  connection: HomeConnection;
  phase: ConnectionPhase;
  cards: ProjectCard[] | null;
  current: Project;
  opening: number | null;
  onOpen: (card: ProjectCard) => void;
  onAdd: () => void;
  onSignIn: () => void;
  onHome: () => void;
}

/** One connection in the connection menu, and the side panel of its projects. */
function ConnectionEntry({
  connection,
  phase,
  cards,
  current,
  opening,
  onOpen,
  onAdd,
  onSignIn,
  onHome,
}: ConnectionEntryProps) {
  const Icon = CONNECTION_ICONS[connection.key.type];
  const isHere = connectionKeyId(connectionKeyFromProject(current)) === connection.id;
  const needsYou = cards?.some((card) => card.needsYou && card.projectId !== current.id);
  const line = phaseLine(phase, cards);
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={cn(row, "py-1.5 data-popup-open:bg-foreground/[0.07]")}>
        <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-foreground/[0.06] text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{connection.name}</span>
          <span
            className={cn(
              "block text-[10.5px]",
              phase.kind === "up" ? "text-muted-foreground" : "text-muted-foreground/60",
            )}
          >
            {line}
          </span>
        </span>
        {needsYou && <span className="size-[7px] shrink-0 rounded-full bg-amber-500" />}
        {isHere && <Check className="size-3.5 shrink-0 text-accent" strokeWidth={2.4} />}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </Menu.SubmenuTrigger>
      <Panel submenu className="w-[320px]">
        <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-2 text-[11px] text-muted-foreground">
          <Icon className="size-3" />
          <span className="truncate">{connection.name}</span>
          {phase.kind === "up" && <span className="ml-auto shrink-0">{line}</span>}
        </div>
        {phase.kind === "up" ? (
          <>
            {cards && cards.length === 0 && (
              <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                No projects yet
              </div>
            )}
            {byStatus(cards ?? []).map((card) => {
              const isCurrent = card.projectId === current.id;
              return (
                <Menu.Item
                  key={card.path}
                  data-attention={card.needsYou}
                  onClick={() => !isCurrent && onOpen(card)}
                  className="mt-1.5 block cursor-pointer rounded-xl border border-foreground/[0.08] bg-background/40 p-2.5 text-xs outline-none select-none first-of-type:mt-0 data-highlighted:bg-background/75 data-[attention=true]:border-amber-500/35 data-[attention=true]:bg-amber-500/[0.13] data-[attention=true]:data-highlighted:bg-amber-500/20"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-semibold">{card.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
                      {displayPath(card.path)}
                    </span>
                    <StatusWord
                      card={card}
                      opening={opening !== null && opening === card.projectId}
                      current={isCurrent}
                    />
                  </div>
                  <div className="mt-0.5 h-4 truncate text-[11px] text-muted-foreground">
                    {context(card)}
                  </div>
                  <div className="mt-1 flex gap-3 text-[11px]">
                    <Count value={card.working} label="working" className="home-working" />
                    <Count value={card.review} label="review" className="home-review" />
                    <Count value={card.queued} label="queued" />
                  </div>
                </Menu.Item>
              );
            })}
            <Separator />
            <Menu.Item onClick={onAdd} className={cn(row, "text-muted-foreground")}>
              <Plus className="size-3.5" />
              Add project
            </Menu.Item>
            {!isHere && cards && cards.length > 0 && (
              <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">
                <Lock className="size-3" />
                Opening one releases {current.name}
              </div>
            )}
          </>
        ) : phase.kind === "connecting" ? (
          <div className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Connecting…
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-3 py-5 text-center text-xs text-muted-foreground">
            {phase.kind === "signin"
              ? "It needs a password before its projects show here."
              : phase.kind === "failed"
                ? "Could not connect. Home shows why."
                : "Not connected. Its projects show here once it is."}
            <Menu.Item
              closeOnClick={
                phase.kind !== "idle" && phase.kind !== "stopped" && phase.kind !== "unreachable"
              }
              onClick={
                phase.kind === "signin"
                  ? onSignIn
                  : phase.kind === "failed"
                    ? onHome
                    : () => void connect(connection.key)
              }
              className="cursor-pointer rounded-full bg-accent px-3.5 py-1 text-[11px] font-medium text-accent-foreground outline-none data-highlighted:opacity-90"
            >
              {phase.kind === "signin"
                ? "Sign in…"
                : phase.kind === "failed"
                  ? "Open Home"
                  : "Connect"}
            </Menu.Item>
          </div>
        )}
      </Panel>
    </Menu.SubmenuRoot>
  );
}

/**
 * The header's `Home / connection / project` path. Home goes back to the board; the connection
 * menu reaches every project on every connection; the project menu lists this connection's.
 */
export function ProjectPath({ project }: { project: Project }) {
  const { clearSelectedProject } = useSelectedProjectActions();
  const connections = useHomeConnections();
  const phases = useHomeStore((s) => s.phases);
  const hidden = useHomeStore((s) => s.hidden);
  const setHidden = useHomeStore((s) => s.setHidden);
  const { openProject, openPath, opening, dialogs } = useOpenProject({
    beforeShow: whenSlidOut,
    onAbandon: slideBack,
  });
  const [addingTo, setAddingTo] = useState<HomeConnection | null>(null);
  const [signInFor, setSignInFor] = useState<HomeConnection | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const hereId = connectionKeyId(connectionKeyFromProject(project));
  const here = connections.find((connection) => connection.id === hereId) ?? connections[0];
  const HereIcon = CONNECTION_ICONS[here.key.type];
  const up = connections.filter((connection) => phases[connection.id]?.kind === "up");
  const summaries = useHomeSummaries(up.map((connection) => connection.key));

  // Projects removed from Home stay out of these menus too.
  const cardsFor = (connection: HomeConnection) =>
    summaries
      .get(connection.id)
      ?.projects.filter((card) => !hidden.includes(projectKey(connection.id, card.path))) ?? null;

  const waiting = up
    .flatMap((connection) => cardsFor(connection) ?? [])
    .filter((card) => card.needsYou && card.projectId !== project.id);
  const homeLabel =
    waiting.length === 0
      ? "Home"
      : waiting.length === 1
        ? `Home · ${waiting[0].name} needs you`
        : `Home · ${waiting.length} projects need you`;

  // The menus' order, connection by connection: the view slides up to a project further down it.
  const order = connections.flatMap((connection) =>
    byStatus(cardsFor(connection) ?? []).map((card) => card.projectId),
  );

  const openCard = (connection: HomeConnection, card: ProjectCard) => {
    const from = order.indexOf(project.id);
    const to = order.indexOf(card.projectId);
    slideOut(to !== -1 && from !== -1 && to < from ? -1 : 1);
    void (card.projectId !== null
      ? openProject(card.projectId)
      : openPath(card.path, connection.key));
  };

  // The project shrinks back into its tile on Home.
  const goHome = () => {
    shrinkToHome(() => tileBox(project));
    clearSelectedProject();
  };

  const submitSignIn = async (submission: AuthSubmission) => {
    const connection = signInFor;
    if (!connection || connection.key.type !== "ssh") return;
    setSigningIn(true);
    try {
      await signInWith(connection.key, submission);
      setSignInFor(null);
      await attach(connection.key);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSigningIn(false);
    }
  };

  const hereCards = phases[here.id]?.kind === "up" ? cardsFor(here) : null;

  return (
    <div data-tauri-drag-region className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={goHome}
              aria-label={homeLabel}
              className={cn(segment, "relative w-7 shrink-0 justify-center px-0")}
            />
          }
        >
          <House className="size-[15px]" />
          {waiting.length > 0 && (
            <span className="absolute top-1 right-1 size-[7px] rounded-full bg-amber-500 ring-2 ring-background" />
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{homeLabel}</p>
        </TooltipContent>
      </Tooltip>
      <Slash />
      <Menu.Root>
        <Menu.Trigger className={cn(segment, "shrink")}>
          <HereIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{here.name}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Menu.Trigger>
        <Panel className="w-60">
          {connections.map((connection) => (
            <ConnectionEntry
              key={connection.id}
              connection={connection}
              phase={phases[connection.id] ?? { kind: "idle" }}
              cards={cardsFor(connection)}
              current={project}
              opening={opening}
              onOpen={(card) => openCard(connection, card)}
              onAdd={() => setAddingTo(connection)}
              onSignIn={() => setSignInFor(connection)}
              onHome={goHome}
            />
          ))}
        </Panel>
      </Menu.Root>
      <Slash />
      <Menu.Root>
        <Menu.Trigger className={cn(segment, "shrink font-semibold")}>
          <span className="truncate">{project.name}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Menu.Trigger>
        <Panel className="w-[300px]">
          {hereCards === null ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">Not connected</div>
          ) : (
            byStatus(hereCards).map((card) => {
              const isCurrent = card.projectId === project.id;
              return (
                <Menu.Item
                  key={card.path}
                  data-attention={card.needsYou}
                  onClick={() => !isCurrent && openCard(here, card)}
                  className={cn(
                    row,
                    "data-[attention=true]:bg-amber-500/[0.12] data-[attention=true]:data-highlighted:bg-amber-500/20",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{card.name}</span>
                      <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {displayPath(card.path)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {context(card) ?? counts(card)}
                    </div>
                  </div>
                  <StatusWord
                    card={card}
                    opening={opening !== null && opening === card.projectId}
                    current={isCurrent}
                  />
                </Menu.Item>
              );
            })
          )}
          <Separator />
          <Menu.Item onClick={() => setAddingTo(here)} className={cn(row, "text-muted-foreground")}>
            <Plus className="size-3.5" />
            Add project
          </Menu.Item>
        </Panel>
      </Menu.Root>

      <AddProjectDialog
        connection={addingTo}
        onClose={() => setAddingTo(null)}
        onOpenPath={(path) => {
          const connection = addingTo ?? here;
          // Opening a folder Home was told to forget brings its tile back, as on Home.
          setHidden(projectKey(connection.id, path), false);
          return openPath(path, connection.key);
        }}
        onOpenProject={(projectId) => openProject(projectId)}
      />
      <SshAuthModal
        open={signInFor !== null}
        username={signInFor?.ssh?.username ?? ""}
        onSubmit={(submission) => void submitSignIn(submission)}
        onCancel={() => setSignInFor(null)}
        loading={signingIn}
      />
      {dialogs}
    </div>
  );
}
