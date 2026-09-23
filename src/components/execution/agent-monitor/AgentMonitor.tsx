import { useMemo, useState, useCallback, useRef, useEffect, memo } from "react";
import { BotOff, GitBranch, Terminal, X } from "lucide-react";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription } from "@/ui/empty";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { SidebarContent, SidebarMenu, SidebarMenuItem, useSidebar } from "@/ui/sidebar";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { AgentActivityPanel } from "@/components/execution/agent-activity-panel/AgentActivityPanel";
import type { ActiveSessionInfo, ConnectionKey } from "@/types/bindings";
import {
  useSessionActivity,
  type SessionActivityStatus,
  type SessionActivityInfo,
} from "@/store/sessionActivityStore";
import {
  useRenameAcpSessionMutation,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useAgentProfilesQuery } from "@/services/project.service";
import { useAutomationRunsQuery } from "@/services/automation.service";
import { ACTIVITY_DOT, ElapsedTime } from "@/components/execution/shared/activityStatus";

const STATUS_FALLBACK: Record<SessionActivityStatus, string> = {
  spawning: "Starting",
  thinking: "Thinking",
  acting: "Calling tool",
  awaiting_input: "Needs your input",
  idle: "Ready",
  stale: "Connection lost",
};

function getStatusDot(
  session: ActiveSessionInfo,
  activityInfo: SessionActivityInfo | undefined,
): string {
  if (session.execution_mode !== "acp") return "";
  const status = activityInfo?.status ?? "thinking";
  if (status === "idle" && activityInfo && !activityInfo.seen) {
    return "bg-success animate-pulse";
  }
  return ACTIVITY_DOT[status];
}

function getStatusLabelClass(activityInfo: SessionActivityInfo | undefined): string {
  if (!activityInfo) return "";
  const { status, seen } = activityInfo;
  switch (status) {
    case "awaiting_input":
      return "text-warning font-medium";
    case "idle":
      return seen ? "" : "text-success";
    case "stale":
      return "text-destructive";
    default:
      return "";
  }
}

function getAvatarRingClass(activityInfo: SessionActivityInfo | undefined): string | null {
  if (!activityInfo) return null;
  const { status, seen } = activityInfo;
  switch (status) {
    case "thinking":
      return "av-ring av-ring-thinking";
    case "acting":
      return "av-ring av-ring-acting";
    case "spawning":
      return "av-ring av-ring-spawning";
    case "awaiting_input":
      return "av-ring av-ring-awaiting";
    case "idle":
      return seen ? null : "av-ring av-ring-done";
    case "stale":
      return "av-ring av-ring-stale";
    default:
      return null;
  }
}

function getStatusLabel(activityInfo: SessionActivityInfo): string {
  const { status, label, seen } = activityInfo;
  if (label) return label;
  if (status === "idle" && !seen) return "Done";
  return STATUS_FALLBACK[status];
}

function AgentIcon({
  agentId,
  src,
  className,
}: {
  agentId: string;
  src?: string;
  className: string;
}) {
  if (hasBrandIcon(agentId)) {
    return <BrandIcon slug={agentId} className={className} />;
  }
  if (src) {
    return (
      <img
        src={src}
        className={cn(className, "dark:filter-[invert(1)]")}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
        alt="agent icon"
      />
    );
  }
  return null;
}

/**
 * Which pipeline role this session runs, for the sessions a task started.
 *
 * On the metadata line rather than beside the name, because the name is editable and a chip next
 * to an input reads as part of it. Sessions are renamed freely, so this is the only thing on the
 * row that still says where the session came from afterwards.
 *
 * The role is on the chip and the profile behind it is in the tooltip: the role is the same four
 * words on every project and so reads at a glance, while the profile is named by whoever wrote it
 * and is what answers "with which settings".
 */
function RoleChip({
  session,
  profileNames,
  tooltip = true,
}: {
  session: ActiveSessionInfo;
  profileNames: Record<string, string>;
  /**
   * Off inside the sidebar row, which is itself one big tooltip trigger for names too long to
   * fit. A trigger nested in a trigger opens both on the same hover, and two tooltips over one
   * chip read as a glitch.
   */
  tooltip?: boolean;
}) {
  if (!session.task_role) return null;
  const { role, profile_id } = session.task_role;
  const chip = (
    <span className="shrink-0 rounded-full border border-border bg-muted/50 px-1.5 text-[11px] leading-[16px] text-muted-foreground">
      {role}
    </span>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>
        {profile_id
          ? // The id rather than nothing when the profile has since been renamed away or deleted:
            // it is what the session actually ran with.
            `Profile: ${profileNames[profile_id] ?? profile_id}`
          : "No profile — the project's default agent"}
      </TooltipContent>
    </Tooltip>
  );
}

interface SessionRowProps {
  session: ActiveSessionInfo;
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
  onClose?: (session: ActiveSessionInfo) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
  profileNames: Record<string, string>;
  /** Which run of its automation this session is, when an automation started it. */
  runOrdinal?: number;
}

const SessionRow = memo(function SessionRow({
  session,
  isSelected,
  onSelect,
  onClose,
  agentIcons,
  profileNames,
  runOrdinal,
}: SessionRowProps) {
  const activityInfo = useSessionActivity(session.session_id);
  const ringClass = session.execution_mode === "acp" ? getAvatarRingClass(activityInfo) : null;
  const name =
    session.session_name ?? session.task_name ?? session.branch_name ?? "Interactive session";

  const nameRef = useRef<HTMLSpanElement>(null);
  const [isNameTruncated, setIsNameTruncated] = useState(false);
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    const checkTruncated = () => setIsNameTruncated(el.scrollWidth > el.clientWidth);
    checkTruncated();
    const observer = new ResizeObserver(checkTruncated);
    observer.observe(el);
    return () => observer.disconnect();
  }, [name]);

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <div
            onClick={() => onSelect(session.session_id)}
            className={cn(
              "pr-row relative flex items-stretch cursor-pointer transition-colors",
              isSelected && "selected-session-item selected",
            )}
          >
            {/* Avatar column */}
            <div className="pr-avatar-col flex items-center justify-center shrink-0">
              <div className="pr-avatar-wrap relative w-8 h-8 shrink-0">
                {ringClass && <div className={ringClass} />}
                <div className="pr-avatar-icon w-8 h-8 rounded-md overflow-hidden relative bg-card">
                  {session.execution_mode === "acp" && session.agent_id ? (
                    <AgentIcon
                      agentId={session.agent_id}
                      src={agentIcons?.[session.agent_id]}
                      className="w-8 h-8 rounded-md bg-muted/40"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-md bg-muted/40 border border-border flex items-center justify-center">
                      <Terminal className="w-4 h-4 text-accent" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Text column */}
            <div className="session-text-col flex-1 min-w-0 pr-3 pl-2 py-2.5 flex flex-col justify-center gap-0.75">
              <div className="flex items-baseline justify-between gap-2 min-w-0">
                <span ref={nameRef} className="session-item-name text-sm font-medium truncate">
                  {name}
                </span>
                <span className="text-xs font-mono text-muted-foreground/40 shrink-0 transition-opacity group-hover/menu-item:opacity-0">
                  {/* An automation's run number matches its entry in run history. Any other
                      daemon-started session is keyed by a uuid, which would push the name out. */}
                  #{runOrdinal ?? session.session_id.slice(0, 8)}
                </span>
              </div>
              {session.execution_mode === "acp" && (
                <div className="text-xs text-muted-foreground flex items-center justify-between gap-2 min-w-0">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <RoleChip session={session} profileNames={profileNames} tooltip={false} />
                    <span className={cn("truncate", getStatusLabelClass(activityInfo))}>
                      {activityInfo ? getStatusLabel(activityInfo) : "Starting…"}
                    </span>
                  </span>
                  {activityInfo && (
                    <span className="transition-opacity group-hover/menu-item:opacity-0">
                      <ElapsedTime
                        status={activityInfo.status}
                        stateChangedAt={activityInfo.stateChangedAt}
                      />
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" hidden={!isNameTruncated}>
          {name}
        </TooltipContent>
      </Tooltip>
      {onClose && (
        // right-3 matches the text column's pr-3 so the X lands exactly where
        // #N and the elapsed time were. Opacity lives on the wrapper so the
        // Button's own disabled:opacity-50 stays unambiguous.
        <span className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/menu-item:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close session"
            className="text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onClose(session);
            }}
          >
            <X className="size-4" />
          </Button>
        </span>
      )}
    </SidebarMenuItem>
  );
});

interface AgentMonitorProps {
  sessions: ActiveSessionInfo[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  search: string;
  onClose?: (session: ActiveSessionInfo) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
  projectId?: number;
  newSessionId?: string | null;
  onSpawnShell?: (
    branchName: string | null,
    taskId: number | null,
    embedded?: boolean,
  ) => Promise<string | null>;
  connection: ConnectionKey;
}

export function AgentMonitor({
  sessions,
  selectedSessionId,
  onSelect,
  search,
  onClose,
  agentIcons,
  agentNames,
  projectId,
  newSessionId,
  onSpawnShell,
  connection,
}: AgentMonitorProps) {
  const { state } = useSidebar();
  const [railExpanded, setRailExpanded] = useState(false);
  const selectedActivityInfo = useSessionActivity(selectedSessionId ?? undefined);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCanceledRef = useRef(false);
  const renameMutation = useRenameAcpSessionMutation();
  const cancelSession = useCancelActiveSessionMutation();
  // A session stores the profile's id; the name lives in the project's profile document. Memoized
  // into a map because `SessionRow` is memoized, and a lookup closure rebuilt each render would
  // re-render every row on every poll.
  const { data: profilesDocument } = useAgentProfilesQuery(projectId ?? null);
  const profileNames = useMemo(
    () =>
      Object.fromEntries(
        (profilesDocument?.profiles ?? []).map((profile) => [profile.id, profile.name]),
      ),
    [profilesDocument],
  );
  // Joined on the agent's own session id rather than ours: a run reopened after the idle sweep
  // closed it is a new session here, but the same conversation to the agent.
  const { data: runs } = useAutomationRunsQuery(projectId ?? null);
  const runOrdinals = useMemo(
    () =>
      new Map(
        (runs ?? []).flatMap((run) =>
          run.agent_session_id && run.ordinal != null ? [[run.agent_session_id, run.ordinal]] : [],
        ),
      ),
    [runs],
  );

  const commitRename = useCallback(
    (session: ActiveSessionInfo) => {
      if (renameCanceledRef.current) {
        renameCanceledRef.current = false;
        setRenamingSessionId(null);
        return;
      }
      const trimmed = renameValue.trim();
      const currentName = session.session_name ?? session.task_name ?? session.branch_name ?? "";
      if (
        trimmed &&
        trimmed !== currentName &&
        projectId != null &&
        session.agent_id &&
        session.acp_session_id
      ) {
        renameMutation.mutate({
          projectId,
          agentId: session.agent_id,
          acpSessionId: session.acp_session_id,
          displayName: trimmed,
        });
      }
      setRenamingSessionId(null);
    },
    [renameValue, projectId, renameMutation],
  );

  const filteredSessions = useMemo(() => {
    return sessions.filter(
      (s) =>
        search.trim() === "" ||
        (s.session_name ?? s.task_name ?? s.branch_name ?? "Interactive")
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  }, [sessions, search]);

  const selectedSession = sessions.find((s) => s.session_id === selectedSessionId);

  const renderSessionHeader = (session: ActiveSessionInfo) => (
    <div className="px-4 py-3 border-b border-border bg-background shrink-0">
      <div className="flex items-center justify-between gap-2">
        {session.execution_mode === "acp" && session.agent_id ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 inline-flex" />}>
              <AgentIcon
                agentId={session.agent_id}
                src={agentIcons?.[session.agent_id]}
                className="w-10 h-10 rounded-sm shrink-0"
              />
            </TooltipTrigger>
            <TooltipContent>{agentNames?.[session.agent_id] ?? session.agent_id}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="w-10 h-10 rounded-sm shrink-0 bg-muted/40 border border-border flex items-center justify-center" />
              }
            >
              <Terminal className="w-5 h-5 text-accent" />
            </TooltipTrigger>
            <TooltipContent>Terminal session</TooltipContent>
          </Tooltip>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {session.execution_mode === "acp" && session.acp_session_id ? (
              <Tooltip disabled={renamingSessionId === session.session_id} trackCursorAxis="x">
                <TooltipTrigger
                  render={
                    <input
                      ref={renameInputRef}
                      className="text-sm font-semibold bg-transparent border border-transparent rounded px-1 -mx-1 outline-none hover:border-border/50 focus:border-border/70 focus:bg-muted/20 transition-colors cursor-default focus:cursor-text min-w-0 flex-1 overflow-hidden whitespace-nowrap mask-[linear-gradient(to_right,black_calc(100%-3rem),transparent)]"
                      value={
                        renamingSessionId === session.session_id
                          ? renameValue
                          : (session.session_name ??
                            session.task_name ??
                            session.branch_name ??
                            "Interactive session")
                      }
                      onFocus={() => {
                        setRenamingSessionId(session.session_id);
                        setRenameValue(
                          session.session_name ?? session.task_name ?? session.branch_name ?? "",
                        );
                        requestAnimationFrame(() => renameInputRef.current?.select());
                      }}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameInputRef.current?.blur();
                        if (e.key === "Escape") {
                          renameCanceledRef.current = true;
                          renameInputRef.current?.blur();
                        }
                      }}
                      onBlur={() => commitRename(session)}
                    />
                  }
                />
                <TooltipContent>Click to rename</TooltipContent>
              </Tooltip>
            ) : (
              <h3 className="text-sm font-semibold flex-1 overflow-hidden whitespace-nowrap mask-[linear-gradient(to_right,black_calc(100%-3rem),transparent)]">
                {session.session_name ??
                  session.task_name ??
                  session.branch_name ??
                  "Interactive session"}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <RoleChip session={session} profileNames={profileNames} />
            {selectedActivityInfo?.status === "stale" ? (
              <>
                <span className="text-xs text-destructive truncate">
                  Connection lost, agent may be stuck
                </span>
                <button
                  onClick={() =>
                    cancelSession.mutate({
                      sessionId: session.session_id,
                      executionMode: session.execution_mode,
                    })
                  }
                  disabled={cancelSession.isPending}
                  className="shrink-0 rounded px-2 py-0.5 text-xs font-medium border border-destructive/40 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                >
                  Force end session
                </button>
              </>
            ) : (
              <>
                {session.execution_mode === "acp" && (
                  <>
                    <span
                      className={cn(
                        "inline-block w-2 h-2 rounded-full shrink-0",
                        getStatusDot(session, selectedActivityInfo),
                      )}
                    />
                    <span className="text-xs text-muted-foreground truncate">
                      {selectedActivityInfo ? getStatusLabel(selectedActivityInfo) : "Starting…"}
                    </span>
                    {selectedActivityInfo && (
                      <ElapsedTime
                        status={selectedActivityInfo.status}
                        stateChangedAt={selectedActivityInfo.stateChangedAt}
                      />
                    )}
                  </>
                )}
                {session.branch_name && (
                  <span className="flex items-center gap-1 min-w-0 text-xs text-muted-foreground">
                    <GitBranch className="w-3 h-3 shrink-0" />
                    <span className="font-mono truncate">{session.branch_name}</span>
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => onClose(session)}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div
        data-state={state}
        data-collapsible={state === "collapsed" ? "icon" : ""}
        onTransitionEnd={(e) => {
          if (e.propertyName === "width") setRailExpanded(e.currentTarget.matches(":hover"));
        }}
        onMouseLeave={() => setRailExpanded(false)}
        className="group session-sidebar flex flex-col bg-card shrink-0 overflow-hidden transition-[width] duration-220 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)]"
      >
        <SidebarContent className="gap-0">
          {filteredSessions.length === 0 && (
            <div className="flex justify-center py-8 text-muted-foreground/30">
              <BotOff className="size-8" strokeWidth={1.5} />
            </div>
          )}
          <SidebarMenu className="gap-0">
            {filteredSessions.map((session) => (
              <SessionRow
                key={session.session_id}
                session={session}
                isSelected={session.session_id === selectedSessionId}
                onSelect={onSelect}
                onClose={state === "collapsed" && !railExpanded ? undefined : onClose}
                agentIcons={agentIcons}
                agentNames={agentNames}
                profileNames={profileNames}
                runOrdinal={
                  session.acp_session_id ? runOrdinals.get(session.acp_session_id) : undefined
                }
              />
            ))}
          </SidebarMenu>
        </SidebarContent>
      </div>

      {/* Content pane */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* ACP panels always mounted so state survives navigation */}
        {sessions
          .filter((s) => s.execution_mode === "acp")
          .map((s) => (
            <div
              key={s.session_id}
              className={cn(
                "flex-1 flex flex-col min-h-0",
                s.session_id !== selectedSessionId && "hidden",
              )}
            >
              <AgentActivityPanel
                sessionId={s.session_id}
                agentId={s.agent_id ?? null}
                connection={connection}
                isSelected={s.session_id === selectedSessionId}
                isNewSession={s.session_id === newSessionId}
                headerSlot={s.session_id === selectedSessionId ? renderSessionHeader(s) : null}
                onSpawnShell={
                  onSpawnShell
                    ? () => onSpawnShell(s.branch_name ?? null, s.task_id ?? null, true)
                    : undefined
                }
              />
            </div>
          ))}

        {selectedSession?.execution_mode !== "acp" && selectedSession != null && (
          <div className="flex-1 flex flex-col min-h-0 bg-card">
            <div className="flex flex-col flex-1 min-h-0 p-[8px_7px_0]">
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r border-border bg-background overflow-hidden">
                {renderSessionHeader(selectedSession)}
                <TerminalComponent
                  key={selectedSession.session_id}
                  sessionId={selectedSession.session_id}
                />
              </div>
            </div>
          </div>
        )}
        {!selectedSession && (
          <div className="flex-1 flex flex-col min-h-0 bg-card">
            <div className="flex flex-col flex-1 min-h-0 p-[8px_7px_0]">
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r border-border bg-background overflow-hidden">
                <Empty>
                  <EmptyDescription>Select a session to view its activity</EmptyDescription>
                </Empty>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
