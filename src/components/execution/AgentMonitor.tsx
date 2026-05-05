import { useMemo, useState, useCallback, useRef } from "react";
import { Plus, Terminal, X } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { TerminalComponent } from "@/components/execution/Terminal";
import { AgentActivityPanel } from "@/components/execution/AgentActivityPanel";
import type { ActiveSessionInfo } from "@/types/bindings";
import { useActivityStatuses, type SessionActivityStatus } from "@/store/sessionActivityStore";
import type { UsageState } from "./activity/types";
import { humanizeTokenCount } from "@/lib/format-utils";
import { useRenameAcpSessionMutation } from "@/services/execution.service";

const ACTIVITY_DOT: Record<SessionActivityStatus, string> = {
  spawning: "bg-muted-foreground/60 animate-pulse",
  working: "bg-success animate-glow",
  idle: "bg-success",
  awaiting_input: "bg-warning",
};

function getStatusDot(
  session: ActiveSessionInfo,
  activityStatus: SessionActivityStatus | undefined,
): string {
  if (session.execution_mode === "acp") {
    return ACTIVITY_DOT[activityStatus ?? "working"];
  }
  return "bg-success animate-pulse";
}

function AgentIcon({ src, className }: { src: string; className: string }) {
  return (
    <img
      src={src}
      className={className}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

interface AgentMonitorProps {
  sessions: ActiveSessionInfo[];
  selectedSessionKey: number | null;
  onSelect: (sessionKey: number) => void;
  search: string;
  onSpawn?: () => void;
  onOpenTerminal?: (session: ActiveSessionInfo) => void;
  onClose?: (session: ActiveSessionInfo) => void;
  agentIcons?: Record<string, string>;
  projectId?: number;
}

export function AgentMonitor({
  sessions,
  selectedSessionKey,
  onSelect,
  search,
  onSpawn,
  onOpenTerminal,
  onClose,
  agentIcons,
  projectId,
}: AgentMonitorProps) {
  const activityStatuses = useActivityStatuses();
  const [sessionUsages, setSessionUsages] = useState<Map<number, UsageState>>(new Map());
  const [renamingKey, setRenamingKey] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameMutation = useRenameAcpSessionMutation();

  const handleUsageChange = useCallback((sessionKey: number, usage: UsageState | null) => {
    setSessionUsages((prev) => {
      const next = new Map(prev);
      if (usage === null) {
        next.delete(sessionKey);
      } else {
        next.set(sessionKey, usage);
      }
      return next;
    });
  }, []);

  const startRename = useCallback((session: ActiveSessionInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingKey(session.session_key);
    setRenameValue(session.session_name ?? session.task_name ?? session.branch_name ?? "");
    setTimeout(() => renameInputRef.current?.select(), 0);
  }, []);

  const commitRename = useCallback(
    (session: ActiveSessionInfo) => {
      const trimmed = renameValue.trim();
      if (trimmed && projectId != null && session.agent_id && session.acp_session_id) {
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

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
        {onSpawn && (
          <div className="px-3 py-2 border-b border-border">
            <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={onSpawn}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              New Session
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
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
                <div
                  key={session.session_key}
                  onClick={() => onSelect(session.session_key)}
                  className={cn(
                    "group px-3 py-3 cursor-pointer border-l-2 transition-colors",
                    session.session_key === selectedSessionKey
                      ? "border-ring bg-muted/20"
                      : "border-transparent hover:bg-muted/10",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-block w-2 h-2 rounded-full shrink-0",
                        getStatusDot(session, activityStatuses[session.session_key]),
                      )}
                    />
                    <span className="text-sm font-medium truncate">
                      {session.session_name ??
                        session.task_name ??
                        session.branch_name ??
                        "Interactive session"}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0.5 shrink-0 flex items-center gap-1"
                    >
                      {session.execution_mode === "acp" &&
                        session.agent_id &&
                        agentIcons?.[session.agent_id] && (
                          <AgentIcon
                            src={agentIcons[session.agent_id]}
                            className="w-3 h-3 rounded-sm brightness-0 dark:invert"
                          />
                        )}
                      {session.execution_mode === "acp"
                        ? session.agent_id
                          ? session.agent_id
                              .split(/[-_]/)
                              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                              .join(" ")
                          : "ACP"
                        : "Terminal"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 pl-4">
                    Running
                    {session.branch_name && grouped.length <= 1 && (
                      <span className="font-mono ml-1">{session.branch_name}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Content pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedSession && (
          <div className="px-4 py-3 border-b border-border bg-muted/30 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {selectedSession.execution_mode === "acp" &&
                    selectedSession.agent_id &&
                    agentIcons?.[selectedSession.agent_id] && (
                      <AgentIcon
                        src={agentIcons[selectedSession.agent_id]}
                        className="w-4 h-4 rounded-sm shrink-0 brightness-0 dark:invert"
                      />
                    )}
                  {renamingKey === selectedSession.session_key ? (
                    <input
                      ref={renameInputRef}
                      className="text-sm font-semibold bg-transparent border-b border-border outline-none w-40"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(selectedSession);
                        if (e.key === "Escape") setRenamingKey(null);
                      }}
                      onBlur={() => commitRename(selectedSession)}
                    />
                  ) : (
                    <h3
                      className={cn(
                        "text-sm font-semibold truncate",
                        selectedSession.execution_mode === "acp" &&
                          selectedSession.acp_session_id &&
                          "cursor-text",
                      )}
                      onDoubleClick={
                        selectedSession.execution_mode === "acp" && selectedSession.acp_session_id
                          ? (e) => startRename(selectedSession, e)
                          : undefined
                      }
                    >
                      {selectedSession.session_name ??
                        selectedSession.task_name ??
                        selectedSession.branch_name ??
                        "Interactive session"}
                    </h3>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full shrink-0",
                      getStatusDot(selectedSession, activityStatuses[selectedSession.session_key]),
                    )}
                  />
                  <span className="text-xs text-muted-foreground">Running</span>
                  {selectedSession.branch_name && (
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {selectedSession.branch_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const usage = sessionUsages.get(selectedSession.session_key);
                  if (!usage || usage.size <= 1) return null;
                  return (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
                      <span>{humanizeTokenCount(usage.used)}</span>
                      {usage.cost !== null && (
                        <span>
                          {usage.cost.amount.toFixed(usage.cost.amount < 0.01 ? 4 : 2)}{" "}
                          {usage.cost.currency}
                        </span>
                      )}
                    </div>
                  );
                })()}
                {selectedSession.execution_mode === "acp" && onOpenTerminal && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => onOpenTerminal(selectedSession)}
                  >
                    <Terminal className="w-3.5 h-3.5 mr-1" />
                    Terminal
                  </Button>
                )}
                {onClose && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    title="Close session"
                    onClick={() => onClose(selectedSession)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
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
                isSelected={s.session_key === selectedSessionKey}
                onUsageChange={(usage) => handleUsageChange(s.session_key, usage)}
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
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Select an agent to view its terminal
          </div>
        )}
      </div>
    </div>
  );
}
