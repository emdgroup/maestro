import {
  Fragment,
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  memo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import { useShallow } from "zustand/shallow";
import { BotOff, ChevronDown, FolderOpen, GitBranch, RotateCw, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription } from "@/ui/empty";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { SidebarContent, SidebarMenu, SidebarMenuItem, useSidebar } from "@/ui/sidebar";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { AgentActivityPanel } from "@/components/execution/agent-activity-panel/AgentActivityPanel";
import { FileSessionPanel } from "./FileSessionPanel";
import { SessionUsageMeters } from "./SessionUsageMeters";
import type { ConnectionKey } from "@/types/bindings";
import type { FileSession, MonitorSession } from "@/store/fileSessionStore";
import {
  useSessionActivity,
  useSessionActivityStore,
  type SessionActivityStatus,
  type SessionActivityInfo,
} from "@/store/sessionActivityStore";
import {
  useRenameAcpSessionMutation,
  useCancelActiveSessionMutation,
  useReloadAcpSessionMutation,
} from "@/services/execution.service";
import {
  getActivity,
  releaseSession,
  subscribeSession,
} from "@/components/execution/activity/sessionRuntime";
import { STAGE_NAMES } from "@/lib/default-profiles";
import { useAgentProfilesQuery } from "@/services/project.service";
import { useAutomationRunsQuery } from "@/services/automation.service";
import { ACTIVITY_DOT } from "@/components/execution/shared/activityStatus";
import { ElapsedTime } from "@/components/execution/shared/ElapsedTime";
import { AgentIcon } from "@/components/common/AgentIcon";
import { activityRank, groupSessions } from "./sessionGroups";

const STATUS_FALLBACK: Record<SessionActivityStatus, string> = {
  spawning: "Starting",
  thinking: "Thinking",
  acting: "Calling tool",
  awaiting_input: "Needs your input",
  idle: "Ready",
  stale: "Connection lost",
};

function getStatusDot(
  session: MonitorSession,
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
  session: MonitorSession;
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
      {STAGE_NAMES[role]}
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
          : "No profile, ran on the project's default agent"}
      </TooltipContent>
    </Tooltip>
  );
}

interface SessionRowProps {
  session: MonitorSession;
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
  onClose?: (session: MonitorSession) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
  profileNames: Record<string, string>;
  /** Which run of its automation this session is, when an automation started it. */
  runOrdinal?: number;
  /**
   * Set when the row sits under its automation's header. The header carries the name, so a name
   * that only repeats it gives way to the run number.
   */
  groupTitle?: string;
}

const SessionRow = memo(function SessionRow({
  session,
  isSelected,
  onSelect,
  onClose,
  agentIcons,
  profileNames,
  runOrdinal,
  groupTitle,
}: SessionRowProps) {
  const activityInfo = useSessionActivity(session.session_id);
  const ringClass = session.execution_mode === "acp" ? getAvatarRingClass(activityInfo) : null;
  const fullName =
    session.session_name ?? session.task_name ?? session.branch_name ?? "Interactive session";
  const groupLabel =
    groupTitle != null &&
    runOrdinal != null &&
    (session.session_name == null || session.session_name === groupTitle)
      ? `Run #${runOrdinal}`
      : null;
  const name = groupLabel ?? fullName;

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
            data-session-id={session.session_id}
            onClick={() => onSelect(session.session_id)}
            className={cn(
              "pr-row relative flex items-stretch cursor-pointer transition-colors",
              isSelected && "selected",
            )}
          >
            {/* Avatar column */}
            <div className="pr-avatar-col flex items-center justify-center shrink-0">
              <div className="pr-avatar-wrap relative w-8 h-8 shrink-0">
                {ringClass && <div className={ringClass} />}
                <div className="pr-avatar-icon w-8 h-8 rounded-md overflow-hidden relative bg-card">
                  {session.execution_mode === "acp" && session.agent_id ? (
                    <AgentIcon
                      agent={{ id: session.agent_id, icon: agentIcons?.[session.agent_id] }}
                      className="size-8 rounded-md bg-muted/40"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-md bg-muted/40 border border-border flex items-center justify-center">
                      {session.execution_mode === "files" ? (
                        <FolderOpen className="w-4 h-4 text-accent" />
                      ) : (
                        <Terminal className="w-4 h-4 text-accent" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Text column */}
            <div className="session-text-col flex-1 min-w-0 -ml-1 pr-3 flex flex-col justify-center gap-0.75">
              <div className="flex items-baseline justify-between gap-2 min-w-0">
                <span ref={nameRef} className="session-item-name text-sm font-medium truncate">
                  {name}
                </span>
                {groupLabel == null && (
                  <span className="text-xs font-mono text-muted-foreground/40 shrink-0 transition-opacity group-hover/menu-item:opacity-0">
                    {/* An automation's run number matches its entry in run history. Any other
                        daemon-started session is keyed by a uuid, which would push the name out. */}
                    #{runOrdinal ?? session.session_id.slice(0, 8)}
                  </span>
                )}
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

function loadCollapsed(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * The fold line over a section of the session list, or over one automation's live runs.
 * Its contents fade with the rail like a row's text, so the collapsed rail keeps a gap between
 * groups rather than a header squeezed into 52px.
 */
function ListHeader({
  open,
  onToggle,
  ranks,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** `activityRank` of every session under the header, for its summary. */
  ranks: number[];
  className?: string;
  children: ReactNode;
}) {
  const waiting = ranks.filter((rank) => rank === 0).length;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center pl-4 pr-3 text-left text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        <span className="session-text-col flex min-w-0 flex-1 items-center gap-1.5">
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground/90">
            {children}
          </span>
          {waiting > 0 ? (
            <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[11px] font-medium normal-case tracking-normal text-warning">
              {waiting === 1 ? "1 needs you" : `${waiting} need you`}
            </span>
          ) : (
            ranks.includes(1) && (
              <span className={cn("size-2 shrink-0 rounded-full", ACTIVITY_DOT.thinking)} />
            )
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Attach the session again from the daemon. Reopening Maestro used to be the only way to get a
 * session's output back, and closing the session instead can take its worktree with it.
 *
 * Hidden while the session has nothing in it: there is no output to get back, and an agent cannot
 * load a conversation that never started, so the reload would lose the session.
 */
function ReloadSessionButton({
  sessionId,
  projectId,
  onReloaded,
}: {
  sessionId: string;
  projectId: number;
  onReloaded: (sessionId: string) => void;
}) {
  const reloadSession = useReloadAcpSessionMutation();
  const subscribe = useCallback((fn: () => void) => subscribeSession(sessionId, fn), [sessionId]);
  const empty = useSyncExternalStore(subscribe, () => getActivity(sessionId).items.length === 0);
  if (empty) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reload session"
            disabled={reloadSession.isPending}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => {
              if (reloadSession.isPending) return;
              reloadSession.mutate(
                { sessionId, projectId },
                {
                  onSuccess: (reloaded) => {
                    if (reloaded === sessionId) return;
                    onReloaded(reloaded);
                    releaseSession(sessionId);
                  },
                },
              );
            }}
          />
        }
      >
        <RotateCw className={cn("w-4 h-4", reloadSession.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipContent>Reload session. It keeps running, worktree included.</TooltipContent>
    </Tooltip>
  );
}

interface AgentMonitorProps {
  sessions: MonitorSession[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  search: string;
  onClose?: (session: MonitorSession) => void;
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
  const runsBySession = useMemo(
    () =>
      new Map(
        (runs ?? []).flatMap((run) => (run.agent_session_id ? [[run.agent_session_id, run]] : [])),
      ),
    [runs],
  );
  const runOf = useCallback(
    (session: MonitorSession) =>
      session.acp_session_id ? runsBySession.get(session.acp_session_id) : undefined,
    [runsBySession],
  );
  // Ranks rather than the activity itself, so a status label ticking over does not re-render the
  // whole monitor: only a session starting or stopping work, or blocking on the user, does.
  const ranks = useSessionActivityStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.entries(s.sessions).map(([id, info]) => [id, activityRank(info.status)]),
      ),
    ),
  );
  const rankOf = useCallback(
    (session: MonitorSession) => ranks[session.session_id] ?? activityRank(undefined),
    [ranks],
  );

  // Folded sections and groups, kept per project across restarts.
  const collapsedKey = `maestro.agents.collapsed.${projectId ?? "none"}`;
  const [collapsedFor, setCollapsedFor] = useState(collapsedKey);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(collapsedKey));
  if (collapsedFor !== collapsedKey) {
    setCollapsedFor(collapsedKey);
    setCollapsed(loadCollapsed(collapsedKey));
  }
  const toggleCollapsed = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    localStorage.setItem(collapsedKey, JSON.stringify([...next]));
  };

  const commitRename = useCallback(
    (session: MonitorSession) => {
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
  const sections = useMemo(
    () =>
      groupSessions(
        filteredSessions,
        (session) => {
          const run = runOf(session);
          return run ? { id: run.automation_id, name: run.automation_name } : undefined;
        },
        rankOf,
      ),
    [filteredSessions, runOf, rankOf],
  );
  // A search shows every match, folded or not.
  const searching = search.trim() !== "";

  // The selected pane slides to the selected row, measured because headers sit between rows.
  const listRef = useRef<HTMLDivElement>(null);
  const [pillY, setPillY] = useState<number | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const row =
      selectedSessionId != null
        ? list?.querySelector(`[data-session-id="${selectedSessionId}"]`)
        : null;
    setPillY(
      list && row ? row.getBoundingClientRect().top - list.getBoundingClientRect().top : null,
    );
  }, [selectedSessionId, sections, collapsed, searching]);

  const selectedSession = sessions.find((s) => s.session_id === selectedSessionId);

  const renderSessionHeader = (session: MonitorSession) => (
    <div className="px-4 py-3 border-b border-accent/10 shrink-0">
      <div className="flex items-center justify-between gap-2">
        {session.execution_mode === "acp" && session.agent_id ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 inline-flex" />}>
              <AgentIcon
                agent={{ id: session.agent_id, icon: agentIcons?.[session.agent_id] }}
                className="size-10 rounded-sm"
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
              {session.execution_mode === "files" ? (
                <FolderOpen className="w-5 h-5 text-accent" />
              ) : (
                <Terminal className="w-5 h-5 text-accent" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {session.execution_mode === "files" ? "Files session" : "Terminal session"}
            </TooltipContent>
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
                      className="text-sm font-semibold bg-transparent border border-transparent rounded px-1 -mx-1 outline-none hover:border-border/50 focus:border-border/70 focus:bg-foreground/7 transition-colors cursor-default focus:cursor-text min-w-0 flex-1 overflow-hidden whitespace-nowrap mask-[linear-gradient(to_right,black_calc(100%-3rem),transparent)]"
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
            {session.execution_mode !== "files" && selectedActivityInfo?.status === "stale" ? (
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
                    <span className="text-xs text-muted-foreground shrink-0">
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
          {session.execution_mode === "acp" && session.acp_session_id && projectId != null && (
            <ReloadSessionButton
              sessionId={session.session_id}
              projectId={projectId}
              onReloaded={onSelect}
            />
          )}
          {session.execution_mode === "acp" && (
            <SessionUsageMeters
              sessionId={session.session_id}
              agentId={session.agent_id ?? null}
              acpSessionId={session.acp_session_id ?? null}
              connection={connection}
            />
          )}
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
        className="group session-sidebar flex flex-col shrink-0 overflow-hidden transition-[width] duration-220 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)]"
      >
        <SidebarContent className="gap-0">
          {filteredSessions.length === 0 && (
            <div className="flex justify-center py-8 text-muted-foreground/30">
              <BotOff className="size-8" strokeWidth={1.5} />
            </div>
          )}
          <div ref={listRef} className="relative">
            {pillY != null && (
              <motion.div
                aria-hidden
                className="glass-pill absolute inset-x-1 top-1 h-12 rounded-xl"
                initial={false}
                animate={{ y: pillY }}
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
              />
            )}
            <SidebarMenu className="relative gap-0">
              {sections.map((section) => {
                const sectionSessions = section.groups.flatMap((g) => g.sessions);
                const sectionOpen = searching || !collapsed.has(section.key);
                return (
                  <Fragment key={section.key}>
                    <ListHeader
                      open={sectionOpen}
                      onToggle={() => toggleCollapsed(section.key)}
                      ranks={sectionSessions.map(rankOf)}
                      className="h-8 pt-2 text-[11px] font-semibold uppercase tracking-wide"
                    >
                      {section.label}
                      <span className="font-normal opacity-70">{sectionSessions.length}</span>
                    </ListHeader>
                    {sectionOpen &&
                      section.groups.map((group) => {
                        const first = group.sessions[0];
                        const row = (session: MonitorSession, groupTitle?: string) => (
                          <SessionRow
                            key={session.session_id}
                            session={session}
                            isSelected={session.session_id === selectedSessionId}
                            onSelect={onSelect}
                            onClose={state === "collapsed" && !railExpanded ? undefined : onClose}
                            agentIcons={agentIcons}
                            agentNames={agentNames}
                            profileNames={profileNames}
                            runOrdinal={runOf(session)?.ordinal ?? undefined}
                            groupTitle={groupTitle}
                          />
                        );
                        if (group.sessions.length === 1) return row(first);
                        const title = runOf(first)?.automation_name ?? "";
                        const groupRanks = group.sessions.map(rankOf);
                        // Something waiting on the user opens its group, folded or not.
                        const groupOpen =
                          searching || groupRanks.includes(0) || !collapsed.has(group.key);
                        return (
                          <Fragment key={group.key}>
                            <ListHeader
                              open={groupOpen}
                              onToggle={() => toggleCollapsed(group.key)}
                              ranks={groupRanks}
                              className="py-1 text-[13px] font-medium"
                            >
                              <span className="truncate">{title}</span>
                            </ListHeader>
                            {groupOpen && group.sessions.map((session) => row(session, title))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </SidebarMenu>
          </div>
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

        {/* Always mounted for the same reason, and here that state includes an unsaved draft. */}
        {sessions
          .filter((s): s is FileSession => s.execution_mode === "files")
          .map((s) => (
            <div
              key={s.session_id}
              className={cn(
                "flex-1 flex flex-col min-h-0",
                s.session_id !== selectedSessionId && "hidden",
              )}
            >
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r inner-glass overflow-hidden">
                {s.session_id === selectedSessionId && renderSessionHeader(s)}
                <div className="relative flex-1 min-h-0">
                  <FileSessionPanel
                    session={s}
                    connection={connection}
                    isActive={s.session_id === selectedSessionId}
                  />
                </div>
              </div>
            </div>
          ))}

        {selectedSession?.execution_mode === "pty" && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r inner-glass overflow-hidden">
                {renderSessionHeader(selectedSession)}
                <div className="relative flex-1 min-h-0">
                  <div className="absolute inset-0">
                    <TerminalComponent
                      key={selectedSession.session_id}
                      sessionId={selectedSession.session_id}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {!selectedSession && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r inner-glass overflow-hidden">
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
