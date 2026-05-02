import { useMemo, useState, useRef, useEffect } from "react";
import { formatDistanceStrict } from "date-fns";
import { Plus, Trash2, RotateCcw, Terminal, Pencil } from "lucide-react";
import { cn } from "@/lib";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { TerminalComponent } from "@/components/execution/Terminal";
import { DeadSessionTerminal } from "@/components/execution/DeadSessionTerminal";
import { AgentActivityPanel } from "@/components/execution/AgentActivityPanel";
import type { ExecutionWithTask } from "@/types/bindings";
import { useSessionActivityStore, type SessionActivityStatus } from "@/store/sessionActivityStore";

export const STATUS_FILTERS = ["All", "running", "complete", "failed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

const TERMINAL_DOT: Record<string, string> = {
  complete: "bg-success",
  failed: "bg-destructive",
  paused: "bg-destructive",
  cancelled: "bg-destructive",
};

const ACTIVITY_DOT: Record<SessionActivityStatus, string> = {
  spawning: "bg-muted-foreground/60 animate-pulse",
  working: "bg-success animate-glow",
  idle: "bg-success",
  awaiting_input: "bg-warning",
};

function getStatusDot(execution: ExecutionWithTask, activityStatus: SessionActivityStatus | undefined): string {
  if (execution.status !== "running") {
    return TERMINAL_DOT[execution.status] ?? "bg-muted";
  }
  if (execution.execution_mode === "acp") {
    return ACTIVITY_DOT[activityStatus ?? "working"];
  }
  // PTY terminal — no granular state
  return "bg-success animate-pulse";
}

export const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  complete: "Done",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

function formatElapsed(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt);
  const end = completedAt ? new Date(completedAt) : new Date();
  return formatDistanceStrict(start, end);
}

function AgentIcon({ src, className }: { src: string; className: string }) {
  return (
    <img
      src={src}
      className={className}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
    />
  );
}

function InlineRename({
  currentName,
  onSave,
  onCancel,
}: {
  currentName: string;
  onSave: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== currentName) {
      onSave(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSave();
        else if (e.key === "Escape") onCancel();
        e.stopPropagation();
      }}
      onBlur={handleSave}
      onClick={(e) => e.stopPropagation()}
      className="text-sm font-medium truncate bg-input border border-border rounded px-1.5 py-0 h-6 w-full outline-none focus:ring-1 focus:ring-ring"
      autoFocus
    />
  );
}

interface AgentMonitorProps {
  executions: ExecutionWithTask[];
  selectedExecutionId: number | null;
  onSelect: (executionId: number) => void;
  search: string;
  statusFilter: StatusFilter;
  onSpawn?: () => void;
  onDelete?: (executionId: number) => void;
  onRename?: (executionId: number, newName: string) => void;
  onReconnect?: (execution: ExecutionWithTask) => void;
  onRestart?: (execution: ExecutionWithTask) => void;
  onOpenTerminal?: (execution: ExecutionWithTask) => void;
  agentIcons?: Record<string, string>;
}

export function AgentMonitor({
  executions,
  selectedExecutionId,
  onSelect,
  search,
  statusFilter,
  onSpawn,
  onDelete,
  onRename,
  onReconnect,
  onRestart,
  onOpenTerminal,
  agentIcons,
}: AgentMonitorProps) {
  const activityStatuses = useSessionActivityStore((s) => s.statuses);
  const [editingId, setEditingId] = useState<number | null>(null);
  const filteredExecutions = useMemo(() => {
    return executions
      .filter((e) => statusFilter === "All" || e.status === statusFilter)
      .filter(
        (e) =>
          search.trim() === "" ||
          (e.session_name ?? e.task_name ?? e.branch_name ?? "Interactive").toLowerCase().includes(search.toLowerCase()),
      );
  }, [executions, statusFilter, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ExecutionWithTask[]>();
    for (const exec of filteredExecutions) {
      const key = exec.branch_name ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(exec);
    }
    return [...groups.entries()];
  }, [filteredExecutions]);

  const selectedExecution = executions.find((e) => e.id === selectedExecutionId);

  // PTY sessions are always keyed by log_id (execution.id), regardless of whether
  // the execution is linked to a task. task_id is a FK to the tasks table, not a session key.
  const terminalSessionId = selectedExecution?.id ?? null;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
        {/* New Session button */}
        {onSpawn && (
          <div className="px-3 py-2 border-b border-border">
            <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={onSpawn}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              New Session
            </Button>
          </div>
        )}
        {/* Execution list */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {filteredExecutions.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No agents match your filter
            </div>
          )}
          {grouped.map(([branchName, execList]) => (
            <div key={branchName || "_none"}>
              {grouped.length > 1 && (
                <div className="px-3 py-1 text-[10px] font-mono text-muted-foreground/50 bg-muted/10 border-b border-border/30 sticky top-0">
                  {branchName || "no branch"}
                </div>
              )}
              {execList.map((execution) => (
                <div
                  key={execution.id}
                  onClick={() => onSelect(execution.id)}
                  className={cn(
                    "group px-3 py-3 cursor-pointer border-l-2 transition-colors",
                    execution.id === selectedExecutionId
                      ? "border-ring bg-muted/20"
                      : "border-transparent hover:bg-muted/10",
                  )}
                >
                  {/* Line 1: status dot + task/branch name */}
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-block w-2 h-2 rounded-full shrink-0",
                        getStatusDot(execution, activityStatuses.get(execution.id)),
                      )}
                    />
                    {editingId === execution.id && onRename ? (
                      <InlineRename
                        currentName={execution.session_name ?? execution.task_name ?? execution.branch_name ?? "Interactive session"}
                        onSave={(newName) => {
                          onRename(execution.id, newName);
                          setEditingId(null);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <span
                        className="text-sm font-medium truncate"
                        onDoubleClick={(e) => {
                          if (onRename) {
                            e.stopPropagation();
                            setEditingId(execution.id);
                          }
                        }}
                      >
                        {execution.session_name ?? execution.task_name ?? execution.branch_name ?? "Interactive session"}
                      </span>
                    )}
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 shrink-0 flex items-center gap-1">
                      {execution.execution_mode === "acp" && execution.agent_id && agentIcons?.[execution.agent_id] && (
                        <AgentIcon src={agentIcons[execution.agent_id]} className="w-3 h-3 rounded-sm brightness-0 dark:invert" />
                      )}
                      {execution.execution_mode === "acp"
                        ? (execution.agent_id
                            ? execution.agent_id.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
                            : "ACP")
                        : "Terminal"}
                    </Badge>
                    <div className="hidden group-hover:flex items-center ml-auto shrink-0 gap-0.5">
                      {onRename && editingId !== execution.id && (
                        <button
                          className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                          onClick={(e) => { e.stopPropagation(); setEditingId(execution.id); }}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                      {onDelete && execution.status !== "running" && (
                        <button
                          className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={(e) => { e.stopPropagation(); onDelete(execution.id); }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Line 2: status label + elapsed time */}
                  <div className="text-xs text-muted-foreground mt-0.5 pl-4">
                    {STATUS_LABEL[execution.status] ?? execution.status} &middot;{" "}
                    {formatElapsed(execution.started_at, execution.completed_at)}
                  </div>
                  {/* Line 3: branch name in monospace (only when not grouped by branch) */}
                  {execution.branch_name && grouped.length <= 1 && (
                    <div className="text-xs text-muted-foreground font-mono mt-0.5 pl-4 truncate">
                      {execution.branch_name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Terminal pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedExecution && (
          <div className="px-4 py-3 border-b border-border bg-muted/30 shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {selectedExecution.execution_mode === "acp" && selectedExecution.agent_id && agentIcons?.[selectedExecution.agent_id] && (
                    <AgentIcon src={agentIcons[selectedExecution.agent_id]} className="w-4 h-4 rounded-sm shrink-0 brightness-0 dark:invert" />
                  )}
                  <h3 className="text-sm font-semibold truncate">
                    {selectedExecution.session_name ??
                      selectedExecution.task_name ??
                      selectedExecution.branch_name ??
                      "Interactive session"}
                  </h3>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full shrink-0",
                      getStatusDot(selectedExecution, activityStatuses.get(selectedExecution.id)),
                    )}
                  />
                  <span className="text-xs text-muted-foreground">
                    {STATUS_LABEL[selectedExecution.status] ?? selectedExecution.status}
                  </span>
                  {selectedExecution.branch_name && (
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {selectedExecution.branch_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedExecution.execution_mode === "acp" && (
                  <>
                    {selectedExecution.status !== "running" && onRestart && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => onRestart(selectedExecution)}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1" />
                        Restart
                      </Button>
                    )}
                    {onOpenTerminal && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => onOpenTerminal(selectedExecution)}
                      >
                        <Terminal className="w-3.5 h-3.5 mr-1" />
                        Terminal
                      </Button>
                    )}
                  </>
                )}
                {selectedExecution.status !== "running" && selectedExecution.execution_mode !== "acp" && onReconnect && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => onReconnect(selectedExecution)}
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1" />
                    Reconnect
                  </Button>
                )}
                {onDelete && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => onDelete(selectedExecution.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* ACP panels are always mounted so state survives navigation to/from terminal sessions.
            Only the selected one is visible; others are hidden via display:none. */}
        {executions
          .filter((e) => e.execution_mode === "acp")
          .map((e) => (
            <div
              key={e.id}
              className={cn("flex-1 flex flex-col min-h-0", e.id !== selectedExecutionId && "hidden")}
            >
              <AgentActivityPanel execution={e} isDead={e.status !== "running"} isSelected={e.id === selectedExecutionId} />
            </div>
          ))}

        {/* PTY terminal / dead session / empty state for non-ACP selections */}
        {selectedExecution?.execution_mode !== "acp" && selectedExecution?.status === "running" && terminalSessionId != null && (
          <TerminalComponent key={terminalSessionId} taskId={terminalSessionId} />
        )}
        {selectedExecution?.execution_mode !== "acp" && selectedExecution && selectedExecution.status !== "running" && (
          <DeadSessionTerminal key={selectedExecution.id} execution={selectedExecution} />
        )}
        {!selectedExecution && (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Select an agent to view its terminal
          </div>
        )}
      </div>
    </div>
  );
}
