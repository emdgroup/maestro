import { useRef, useEffect, useState, memo } from "react";
import { Task, TaskStatus } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { useInterruptTaskMutation, useArchiveTaskMutation } from "@/services/task.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { ShieldAlert } from "lucide-react";
import { PRIORITY_COLORS } from "@/utils/constants/priority";
import { useSortable } from "@dnd-kit/react/sortable";
import { cn } from "@/lib/ui-utils";
import { useSessionActivity, type SessionActivityStatus, type SessionActivityInfo } from "@/store/sessionActivityStore";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";

interface TaskCardProps {
  task: Task;
  index: number;
  dndGroup?: TaskStatus;
  onReviewClick?: (taskId: number, taskName: string) => void;
  worktreeTaskIds: Set<number>;
}

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

function SessionStatusRow({ sessionKey }: { sessionKey: number }) {
  const activityInfo = useSessionActivity(sessionKey);
  if (!activityInfo) {
    return (
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-muted-foreground/60 animate-pulse" />
        <span className="text-xs text-muted-foreground">Starting…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
      <span
        className={cn("inline-block w-2 h-2 rounded-full shrink-0", ACTIVITY_DOT[activityInfo.status])}
      />
      <span className="text-xs text-muted-foreground truncate flex-1">
        {getStatusLabel(activityInfo)}
      </span>
      <ElapsedTime status={activityInfo.status} stateChangedAt={activityInfo.stateChangedAt} />
    </div>
  );
}

function formatAgentName(agentId: string): string {
  return agentId
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function TaskCard({ task, index, dndGroup, onReviewClick, worktreeTaskIds }: TaskCardProps) {
  const { projectId, projectPath, connection } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();
  const { execute: handleExecute, isExecuting } = useExecuteTask(
    projectId,
    projectPath,
    connection,
  );
  const interruptTask = useInterruptTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const activeSession = useTaskActiveSession(task.status === "InProgress" ? task.id : null, projectId);

  const isDraggable = task.status === "Backlog" || task.status === "Ready";

  const { ref, isDragging } = useSortable({
    id: task.id,
    index,
    type: "item",
    accept: ["item"],
    group: dndGroup ?? task.status,
    disabled: !isDraggable,
  });

  const dragOccurredRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      dragOccurredRef.current = true;
    } else {
      const raf = requestAnimationFrame(() => { dragOccurredRef.current = false; });
      return () => cancelAnimationFrame(raf);
    }
  }, [isDragging]);

  const hasMetadata = task.priority !== "None" || task.labels.length > 0 || task.auto_approve || task.agent_id;

  return (
    <div
      ref={ref}
      className={`rounded-lg border bg-card shadow-sm p-3 mb-3 transition-all duration-200 hover:shadow-md hover:border-ring
        ${isDragging ? "opacity-30 border-dashed border-accent/40 bg-accent/5" : "border-border"}
        ${isDraggable && !isDragging ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
      `}
      onClick={() => {
        if (dragOccurredRef.current) {
          dragOccurredRef.current = false;
          return;
        }
        setActiveTaskId(task.id);
      }}
    >
      {/* Row 1: Title */}
      <p className="text-sm font-medium text-foreground line-clamp-2">{task.title}</p>

      {/* Row 2: Description */}
      {task.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{task.description}</p>
      )}

      {/* Row 3: Metadata (priority dot + labels + agent + auto-approve) */}
      {hasMetadata && (
        <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
          {task.priority !== "None" && (
            <span
              style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
              className="h-[7px] w-[7px] rounded-full shrink-0 inline-block"
            />
          )}
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground shrink-0"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-xs text-muted-foreground shrink-0">+{task.labels.length - 3}</span>
          )}
          {task.agent_id && (
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              {hasBrandIcon(task.agent_id) ? (
                <BrandIcon slug={task.agent_id} className="w-3.5 h-3.5 rounded-sm" />
              ) : (
                <span>{formatAgentName(task.agent_id)}</span>
              )}
            </span>
          )}
          {task.auto_approve && (
            <ShieldAlert className={cn("h-3.5 w-3.5 text-amber-500 shrink-0", !task.agent_id && "ml-auto")} />
          )}
        </div>
      )}

      {/* Row 4: Session status (InProgress only) */}
      {task.status === "InProgress" && activeSession && (
        <SessionStatusRow sessionKey={activeSession.session_key} />
      )}

      {/* Row 5: Footer (worktree badge left, action button right) */}
      <div className="flex items-center justify-between mt-2">
        <div>
          {worktreeTaskIds.has(task.id) && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              worktree
            </span>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {task.status === "Ready" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleExecute(task);
              }}
              disabled={isExecuting}
              className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {isExecuting ? "..." : "▶ Execute"}
            </button>
          )}
          {task.status === "InProgress" && (
            <>
              {activeSession && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ agentId: String(task.id) });
                  }}
                  className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90"
                >
                  Join
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  interruptTask.mutate(task.id);
                }}
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80"
              >
                ⏹ Interrupt
              </button>
            </>
          )}
          {task.status === "Review" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReviewClick?.(task.id, task.title);
              }}
              className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Review
            </button>
          )}
          {task.status === "Done" && !task.archived_at && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                archiveTask.mutate(task.id);
              }}
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80"
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
