import { useMemo, useState, useCallback, useRef, memo } from "react";
import { X } from "lucide-react";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { cn } from "@/lib/utils.ts";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription } from "@/ui/empty";
import { ScrollArea } from "@/ui/scroll-area";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { AgentActivityPanel } from "@/components/execution/agent-activity-panel/AgentActivityPanel";
import type { ActiveSessionInfo, ConnectionKey } from "@/types/bindings";
import {
  useSessionActivity,
  type SessionActivityStatus,
  type SessionActivityInfo,
} from "@/store/sessionActivityStore";
import { useRenameAcpSessionMutation } from "@/services/execution.service";
import { ACTIVITY_DOT, ElapsedTime } from "@/components/execution/shared/activityStatus";

const STATUS_FALLBACK: Record<SessionActivityStatus, string> = {
  spawning: "Starting",
  thinking: "Thinking",
  acting: "Calling tool",
  awaiting_input: "Waiting",
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

interface SessionRowProps {
  session: ActiveSessionInfo;
  isSelected: boolean;
  onSelect: (sessionKey: number) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
}

const SessionRow = memo(function SessionRow({
  session,
  isSelected,
  onSelect,
  agentIcons,
  agentNames,
}: SessionRowProps) {
  const activityInfo = useSessionActivity(session.session_key);
  return (
    <div
      onClick={() => onSelect(session.session_key)}
      className={cn(
        "group px-3 py-3 cursor-pointer transition-colors",
        isSelected ? "selected-session-item" : "hover:bg-muted/10",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {session.execution_mode === "acp" && (
          <span
            className={cn(
              "inline-block w-2 h-2 rounded-full shrink-0",
              getStatusDot(session, activityInfo),
            )}
          />
        )}
        <span className="session-item-name text-sm font-medium truncate">
          {session.session_name ??
            session.task_name ??
            session.branch_name ??
            "Interactive session"}
        </span>
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0.5 shrink-0 flex items-center gap-1 ml-auto [&>svg]:size-4!"
        >
          {session.execution_mode === "acp" && session.agent_id && (
            <AgentIcon
              agentId={session.agent_id}
              src={agentIcons?.[session.agent_id]}
              className="w-4 h-4 rounded-sm"
            />
          )}
          {session.execution_mode === "acp"
            ? session.agent_id
              ? (agentNames?.[session.agent_id] ??
                session.agent_id
                  .split(/[-_]/)
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(" "))
              : "ACP"
            : "Terminal"}
        </Badge>
      </div>
      {session.execution_mode === "acp" && (
        <div className="text-xs text-muted-foreground mt-0.5 pl-4 flex items-center justify-between gap-2 min-w-0">
          <span className="truncate">
            {activityInfo ? getStatusLabel(activityInfo) : "Starting…"}
          </span>
          {activityInfo && (
            <ElapsedTime
              status={activityInfo.status}
              stateChangedAt={activityInfo.stateChangedAt}
            />
          )}
        </div>
      )}
    </div>
  );
});

interface AgentMonitorProps {
  sessions: ActiveSessionInfo[];
  selectedSessionKey: number | null;
  onSelect: (sessionKey: number) => void;
  search: string;
  onClose?: (session: ActiveSessionInfo) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
  projectId?: number;
  newSessionKey?: number | null;
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (v: boolean) => void;
  onSpawnShell?: (
    branchName: string | null,
    taskId: number | null,
    embedded?: boolean,
  ) => Promise<number | null>;
  connection: ConnectionKey;
}

export function AgentMonitor({
  sessions,
  selectedSessionKey,
  onSelect,
  search,
  onClose,
  agentIcons,
  agentNames,
  projectId,
  newSessionKey,
  sidebarCollapsed = false,
  onSpawnShell,
  connection,
}: AgentMonitorProps) {
  const selectedActivityInfo = useSessionActivity(selectedSessionKey ?? undefined);
  const [renamingKey, setRenamingKey] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCanceledRef = useRef(false);
  const renameMutation = useRenameAcpSessionMutation();

  const commitRename = useCallback(
    (session: ActiveSessionInfo) => {
      if (renameCanceledRef.current) {
        renameCanceledRef.current = false;
        setRenamingKey(null);
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
      setRenamingKey(null);
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

  const grouped = useMemo(() => {
    const groups = new Map<string, ActiveSessionInfo[]>();
    for (const session of filteredSessions) {
      const key = session.branch_name ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(session);
    }
    return [...groups.entries()];
  }, [filteredSessions]);

  const selectedSession = sessions.find((s) => s.session_key === selectedSessionKey);

  const renderSessionHeader = (session: ActiveSessionInfo) => (
    <div className="px-4 py-3 border-b border-border bg-muted/30 shrink-0">
      <div className="flex items-center justify-between gap-2">
        {session.execution_mode === "acp" && session.agent_id && (
          <AgentIcon
            agentId={session.agent_id}
            src={agentIcons?.[session.agent_id]}
            className="w-10 h-10 rounded-sm shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {session.execution_mode === "acp" && session.acp_session_id ? (
              <input
                ref={renameInputRef}
                className="text-sm font-semibold bg-transparent border border-transparent rounded px-1 -mx-1 outline-none hover:border-border/50 focus:border-border/70 focus:bg-muted/20 transition-colors cursor-default focus:cursor-text min-w-0 flex-1 overflow-hidden whitespace-nowrap mask-[linear-gradient(to_right,black_calc(100%-3rem),transparent)]"
                value={
                  renamingKey === session.session_key
                    ? renameValue
                    : (session.session_name ??
                      session.task_name ??
                      session.branch_name ??
                      "Interactive session")
                }
                title="Click to rename"
                onFocus={() => {
                  setRenamingKey(session.session_key);
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
              <span className="text-xs text-muted-foreground font-mono truncate">
                {session.branch_name}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onClose && (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                  disabled={session.task_id != null}
                  onClick={() => onClose(session)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              {session.task_id != null && (
                <TooltipContent>
                  Task sessions can only be stopped from the task card
                </TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div
        className={cn(
          "flex flex-col border-r border-border bg-card shrink-0 transition-[width] duration-200 overflow-hidden",
          sidebarCollapsed ? "w-0" : "w-72",
        )}
      >
        <ScrollArea className="flex-1">
          {filteredSessions.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">No active sessions</div>
          )}
          {grouped.map(([branchName, sessionList]) => (
            <div key={branchName || "_none"}>
              {grouped.length > 1 && (
                <div className="px-3 py-1 text-[10px] font-mono text-muted-foreground/50 bg-muted/10 border-b border-border/30 sticky top-0">
                  {branchName || "no branch"}
                </div>
              )}
              {sessionList.map((session) => (
                <SessionRow
                  key={session.session_key}
                  session={session}
                  isSelected={session.session_key === selectedSessionKey}
                  onSelect={onSelect}
                  agentIcons={agentIcons}
                  agentNames={agentNames}
                />
              ))}
            </div>
          ))}
        </ScrollArea>
      </div>

      {/* Content pane */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* ACP panels always mounted so state survives navigation */}
        {sessions
          .filter((s) => s.execution_mode === "acp")
          .map((s) => (
            <div
              key={s.session_key}
              className={cn(
                "flex-1 flex flex-col min-h-0",
                s.session_key !== selectedSessionKey && "hidden",
              )}
            >
              <AgentActivityPanel
                sessionKey={s.session_key}
                agentId={s.agent_id ?? null}
                connection={connection}
                isSelected={s.session_key === selectedSessionKey}
                isNewSession={s.session_key === newSessionKey}
                headerSlot={s.session_key === selectedSessionKey ? renderSessionHeader(s) : null}
                onSpawnShell={
                  onSpawnShell
                    ? () => onSpawnShell(s.branch_name ?? null, s.task_id ?? null, true)
                    : undefined
                }
              />
            </div>
          ))}

        {selectedSession?.execution_mode !== "acp" && selectedSession != null && (
          <TerminalComponent
            key={selectedSession.session_key}
            taskId={selectedSession.session_key}
          />
        )}
        {!selectedSession && (
          <Empty>
            <EmptyDescription>Select an agent to view its terminal</EmptyDescription>
          </Empty>
        )}
      </div>
    </div>
  );
}
