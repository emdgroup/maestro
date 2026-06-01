import { useMemo, useState, useCallback, useRef, useEffect, memo } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { Terminal, X, FileText, FileDiff } from "lucide-react";
import { ShortcutHint } from "@/components/common/ShortcutHint";
import { BrandIcon, hasBrandIcon } from "@/components/common/BrandIcon";
import { cn } from "@/lib/ui-utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { TerminalComponent } from "@/components/execution/Terminal";
import { AgentActivityPanel } from "@/components/execution/AgentActivityPanel";
import { WorkingFilesPanel } from "@/components/execution/activity/WorkingFilesPanel";
import { ReviewChangesPanel } from "@/components/execution/activity/ReviewChangesPanel";
import type { ActiveSessionInfo } from "@/types/bindings";
import {
  useSessionActivity,
  type SessionActivityStatus,
  type SessionActivityInfo,
} from "@/store/sessionActivityStore";
import { useRenameAcpSessionMutation } from "@/services/execution.service";

const ACTIVITY_DOT: Record<SessionActivityStatus, string> = {
  spawning: "bg-muted-foreground/60 animate-pulse",
  thinking: "bg-purple animate-glow-purple",
  acting: "bg-info animate-glow-info",
  awaiting_input: "bg-warning animate-pulse",
  idle: "bg-muted-foreground/40",
};

const STATUS_FALLBACK: Record<SessionActivityStatus, string> = {
  spawning: "Starting",
  thinking: "Thinking",
  acting: "Calling tool",
  awaiting_input: "Waiting",
  idle: "Ready",
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

function formatElapsedCompact(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatTimeAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function getStatusLabel(activityInfo: SessionActivityInfo): string {
  const { status, label, seen } = activityInfo;
  if (label) return label;
  if (status === "idle" && !seen) return "Done";
  return STATUS_FALLBACK[status];
}

const ElapsedTime = memo(function ElapsedTime({
  status,
  stateChangedAt,
}: {
  status: SessionActivityStatus;
  stateChangedAt: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
      {status === "idle"
        ? formatTimeAgo(now - stateChangedAt)
        : formatElapsedCompact(now - stateChangedAt)}
    </span>
  );
});

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
        className={cn(className, "dark:[filter:invert(1)]")}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
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
  onOpenTerminal?: (session: ActiveSessionInfo) => void;
  onClose?: (session: ActiveSessionInfo) => void;
  agentIcons?: Record<string, string>;
  agentNames?: Record<string, string>;
  projectId?: number;
}

export function AgentMonitor({
  sessions,
  selectedSessionKey,
  onSelect,
  search,
  onOpenTerminal,
  onClose,
  agentIcons,
  agentNames,
  projectId,
}: AgentMonitorProps) {
  const selectedActivityInfo = useSessionActivity(selectedSessionKey ?? undefined);
  const [renamingKey, setRenamingKey] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCanceledRef = useRef(false);
  const renameMutation = useRenameAcpSessionMutation();
  const [openPanel, setOpenPanel] = useState<"working-files" | "review-changes" | null>(null);
  const [sessionWorkingFiles, setSessionWorkingFiles] = useState<Map<number, string[]>>(new Map());
  const [sessionChangedFiles, setSessionChangedFiles] = useState<Map<number, string[]>>(new Map());

  const handleWorkingFilesChange = useCallback((sessionKey: number, files: string[]) => {
    setSessionWorkingFiles((prev) => {
      const existing = prev.get(sessionKey);
      if (existing && existing.length === files.length && existing.every((f, i) => f === files[i]))
        return prev;
      const next = new Map(prev);
      next.set(sessionKey, files);
      return next;
    });
  }, []);

  const handleSessionChangedFilesChange = useCallback((sessionKey: number, files: string[]) => {
    setSessionChangedFiles((prev) => {
      const existing = prev.get(sessionKey);
      if (existing && existing.length === files.length && existing.every((f, i) => f === files[i]))
        return prev;
      const next = new Map(prev);
      next.set(sessionKey, files);
      return next;
    });
  }, []);

  const prevSelectedKeyRef = useRef(selectedSessionKey);
  if (prevSelectedKeyRef.current !== selectedSessionKey) {
    prevSelectedKeyRef.current = selectedSessionKey;
    if (openPanel !== null) setOpenPanel(null);
  }

  useShortcuts("agents", {
    "agents-working":     () => {
      if (selectedSessionKey != null) setOpenPanel("working-files");
    },
    "agents-review":      () => {
      if (selectedSessionKey != null) setOpenPanel("review-changes");
    },
    "agents-close-panel": () => {
      if (openPanel !== null) setOpenPanel(null);
    },
  });

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

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
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
        </div>
      </div>

      {/* Content pane */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {selectedSession && (
          <div className="px-4 py-3 border-b border-border bg-muted/30 shrink-0">
            <div className="flex items-center justify-between gap-2">
              {selectedSession.execution_mode === "acp" && selectedSession.agent_id && (
                <AgentIcon
                  agentId={selectedSession.agent_id}
                  src={agentIcons?.[selectedSession.agent_id]}
                  className="w-10 h-10 rounded-sm shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {selectedSession.execution_mode === "acp" && selectedSession.acp_session_id ? (
                    <input
                      ref={renameInputRef}
                      className="text-sm font-semibold bg-transparent border border-transparent rounded px-1 -mx-1 outline-none hover:border-border/50 focus:border-border/70 focus:bg-muted/20 transition-colors cursor-default focus:cursor-text min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_3rem),transparent)]"
                      value={
                        renamingKey === selectedSession.session_key
                          ? renameValue
                          : (selectedSession.session_name ??
                            selectedSession.task_name ??
                            selectedSession.branch_name ??
                            "Interactive session")
                      }
                      title="Click to rename"
                      onFocus={() => {
                        setRenamingKey(selectedSession.session_key);
                        setRenameValue(
                          selectedSession.session_name ??
                            selectedSession.task_name ??
                            selectedSession.branch_name ??
                            "",
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
                      onBlur={() => commitRename(selectedSession)}
                    />
                  ) : (
                    <h3 className="text-sm font-semibold flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_3rem),transparent)]">
                      {selectedSession.session_name ??
                        selectedSession.task_name ??
                        selectedSession.branch_name ??
                        "Interactive session"}
                    </h3>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {selectedSession.execution_mode === "acp" && (
                    <>
                      <span
                        className={cn(
                          "inline-block w-2 h-2 rounded-full shrink-0",
                          getStatusDot(selectedSession, selectedActivityInfo),
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
                  {selectedSession.branch_name && (
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {selectedSession.branch_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedSession.execution_mode === "acp" && (
                  <>
                    <ShortcutHint shortcutId="agents-working">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        disabled={
                          (sessionWorkingFiles.get(selectedSession.session_key)?.length ?? 0) === 0
                        }
                        onClick={() => setOpenPanel("working-files")}
                      >
                        <FileText className="w-3.5 h-3.5 mr-1" />
                        Working Files
                        {(sessionWorkingFiles.get(selectedSession.session_key)?.length ?? 0) > 0 && (
                          <span className="ml-1.5 px-1.5 rounded-full bg-muted text-[10px] font-semibold text-muted-foreground leading-4">
                            {sessionWorkingFiles.get(selectedSession.session_key)!.length}
                          </span>
                        )}
                      </Button>
                    </ShortcutHint>
                    <ShortcutHint shortcutId="agents-review">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setOpenPanel("review-changes")}
                      >
                        <FileDiff className="w-3.5 h-3.5 mr-1" />
                        Review Changes
                      </Button>
                    </ShortcutHint>
                  </>
                )}
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
                <div className="w-px h-4 bg-border shrink-0" />
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
                agentId={s.agent_id ?? null}
                isSelected={s.session_key === selectedSessionKey}
                onWorkingFilesChange={handleWorkingFilesChange}
                onSessionChangedFilesChange={handleSessionChangedFilesChange}
                onOpenPanel={s.session_key === selectedSessionKey ? setOpenPanel : undefined}
              />
            </div>
          ))}

        {selectedSessionKey != null && openPanel === "working-files" && (
          <WorkingFilesPanel
            sessionKey={selectedSessionKey}
            files={sessionWorkingFiles.get(selectedSessionKey) ?? []}
            onClose={() => setOpenPanel(null)}
          />
        )}
        {selectedSessionKey != null && openPanel === "review-changes" && (
          <ReviewChangesPanel
            sessionKey={selectedSessionKey}
            sessionChangedFiles={sessionChangedFiles.get(selectedSessionKey) ?? []}
            onClose={() => setOpenPanel(null)}
          />
        )}

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
