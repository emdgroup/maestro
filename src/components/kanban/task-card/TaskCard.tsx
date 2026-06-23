import { useRef, useEffect, useMemo, CSSProperties } from "react";
import { Task, TaskStatus } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import { useInterruptTaskMutation, useArchiveTaskMutation } from "@/services/task.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import {
  ShieldAlert,
  Play,
  Square,
  GitPullRequest,
  Archive,
  MessageSquare,
  Flame,
  ArrowUp,
  Minus,
  ArrowDown,
  GitBranch,
  ExternalLink,
  BotMessageSquare,
} from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { cn } from "@/lib/ui-utils";
import { useSessionActivity, type SessionActivityInfo } from "@/store/sessionActivityStore";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { ACTIVITY_TEXT, ElapsedTime } from "@/components/execution/shared/activityStatus";
import { colors } from "@/components/kanban/kanban-column/KanbanColumn.tsx";

interface TaskCardProps {
  task: Task;
  index: number;
  dndGroup?: TaskStatus;
  onReviewClick?: (taskId: number, taskName: string) => void;
}

function AgentAvatar({ agentId }: { agentId: string }) {
  return hasBrandIcon(agentId) ? (
    <div className="size-6 rounded-full overflow-hidden shrink-0 flex items-center justify-center bg-muted">
      <BrandIcon slug={agentId} className="size-5" />
    </div>
  ) : (
    <span className="text-[8px] font-bold text-muted-foreground uppercase">{agentId}</span>
  );
}

function ActivityLine({ activityInfo }: { activityInfo: SessionActivityInfo | undefined }) {
  if (!activityInfo) {
    return (
      <div className="flex items-center gap-1 mb-1.5 text-[10px]">
        <span className="font-bold text-muted-foreground shrink-0">Starting</span>
      </div>
    );
  }
  const { status, label, stateChangedAt } = activityInfo;
  return (
    <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
      <span className={cn("font-bold shrink-0", ACTIVITY_TEXT[status])}>
        {status.toUpperCase()}
      </span>
      {label && (
        <>
          <span className="text-muted-foreground/40 shrink-0">·</span>
          <span className="text-muted-foreground truncate flex-1">{label}</span>
        </>
      )}
      <ElapsedTime status={status} stateChangedAt={stateChangedAt} />
    </div>
  );
}

function PriorityOpt({ priority }: { priority: string }) {
  if (priority === "Urgent")
    return (
      <span className="flex items-center gap-0.5 text-[9.5px] text-[oklch(68%_0.2_25)]">
        <Flame className="w-2.5 h-2.5 fill-current" />
        Urgent
      </span>
    );
  if (priority === "High")
    return (
      <span className="flex items-center gap-0.5 text-[9.5px] text-[oklch(72%_0.18_55)]">
        <ArrowUp className="w-2.5 h-2.5" />
        High
      </span>
    );
  if (priority === "Medium")
    return (
      <span className="flex items-center gap-0.5 text-[9.5px] text-muted-foreground">
        <Minus className="w-2.5 h-2.5" />
        Medium
      </span>
    );
  if (priority === "Low")
    return (
      <span className="flex items-center gap-0.5 text-[9.5px] text-success">
        <ArrowDown className="w-2.5 h-2.5" />
        Low
      </span>
    );
  return null;
}

interface FooterCTAsProps {
  task: Task;
  activeSession: { session_key: number } | undefined | null;
  isAwaiting: boolean;
  isExecuting: boolean;
  onExecute: () => void;
  onStop: () => void;
  onJoin: () => void;
  onReview: () => void;
  onArchive: () => void;
}

function FooterCTAs({
  task,
  activeSession,
  isAwaiting,
  isExecuting,
  onExecute,
  onStop,
  onJoin,
  onReview,
  onArchive,
}: FooterCTAsProps) {
  const base =
    "flex-1 flex items-center justify-center gap-1 text-[10px] font-bold py-2 rounded-full border border-border bg-primary-foreground text-primary hover:bg-muted disabled:opacity-50";

  if (task.status === "Ready") {
    return (
      <div className="flex gap-1 mt-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onExecute();
          }}
          disabled={isExecuting}
          className={base}
        >
          <Play className="w-2.5 h-2.5 fill-current" />
          {isExecuting ? "Starting…" : "Execute"}
        </button>
      </div>
    );
  }

  if (task.status === "InProgress") {
    if (isAwaiting) {
      return (
        <div className="flex gap-1 mt-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            className={base}
          >
            <MessageSquare className="w-2.5 h-2.5 fill-current" />
            Respond
          </button>
        </div>
      );
    }
    return (
      <div className="flex gap-1 mt-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          className={cn(base, "bg-foreground text-background")}
        >
          <Square className="w-2.5 h-2.5 fill-current" />
          Stop
        </button>
        {activeSession && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            className={base}
          >
            <BotMessageSquare className="w-2.5 h-2.5 fill-current" />
            Join
          </button>
        )}
      </div>
    );
  }

  if (task.status === "Review") {
    return (
      <div className="flex gap-1 mt-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReview();
          }}
          className={base}
        >
          <GitPullRequest className="w-2.5 h-2.5 fill-current" />
          Review
        </button>
      </div>
    );
  }

  if (task.status === "Done" && !task.archived_at) {
    return (
      <div className="flex gap-1 mt-1.5">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          className={cn(base, "bg-foreground text-background")}
        >
          <Archive className="w-2.5 h-2.5" />
          Archive
        </button>
      </div>
    );
  }

  return null;
}

export function TaskCard({ task, index, dndGroup, onReviewClick }: TaskCardProps) {
  const { projectId, projectPath, connection } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();
  const {
    execute: handleExecute,
    isExecuting,
    dirtyDialogOpen,
    dirtyModifiedCount,
    dirtyUntrackedCount,
    onDirtyChoice,
    onDirtyCancel,
  } = useExecuteTask(projectId, projectPath, connection);
  const interruptTask = useInterruptTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const activeSession = useTaskActiveSession(
    task.status === "InProgress" ? task.id : null,
    projectId,
  );
  const activityInfo = useSessionActivity(activeSession?.session_key);
  const activityStatus = activityInfo?.status ?? null;
  const isAwaiting = task.status === "InProgress" && activityStatus === "awaiting_input";

  const isDraggable = task.status === "Backlog" || task.status === "Ready";

  const { ref, isDragging } = useSortable({
    id: task.id,
    index,
    type: "item",
    accept: ["item"],
    group: dndGroup ?? task.status,
    disabled: !isDraggable,
    collisionDetector: pointerIntersection,
  });

  const dragOccurredRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      dragOccurredRef.current = true;
    } else {
      const raf = requestAnimationFrame(() => {
        dragOccurredRef.current = false;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isDragging]);

  const cardColor = useMemo((): string => {
    return colors[task.status];
  }, [task.status]);

  const hasOptions = task.priority !== "None" || task.isolated_worktree || task.auto_approve;

  return (
    <>
      <div
        ref={ref}
        style={
          {
            "--card-color": cardColor,
            "--card-bg-color": `color-mix(in oklab, var(--card-color) ${isAwaiting ? "30%" : "12%"}, transparent)`,
          } as CSSProperties
        }
        className={cn(
          "rounded-lg border p-2.5 mb-2 flex flex-col transition-all border-(--card-color) bg-(--card-bg-color)",
          "hover:shadow-md",
          isAwaiting && "animate-glow-warning",
          isDragging && "opacity-30 border-dashed",
          isDraggable && !isDragging ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        )}
        onClick={() => {
          if (dragOccurredRef.current) {
            dragOccurredRef.current = false;
            return;
          }
          setActiveTaskId(task.id);
        }}
      >
        {/* Header: title + agent avatar right */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              {task.is_imported ? task.external_id : `task-${task.id}`}
            </span>
            {task.is_imported && task.external_url && (
              <ExternalLink className="size-4" href={task.external_url} />
            )}
          </div>
          {task.agent_id && <AgentAvatar agentId={task.agent_id} />}
        </div>

        {/* Title */}
        <p className="text-[12px] font-semibold text-card-foreground line-clamp-2 mb-1.5">
          {task.title}
        </p>

        {/* Activity line — InProgress with active session only */}
        {task.status === "InProgress" && activeSession && (
          <ActivityLine activityInfo={activityInfo} />
        )}

        {/* Tags */}
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1">
            {task.labels.slice(0, 3).map((l) => (
              <span
                key={l}
                className="text-[9.5px] px-1.5 py-px rounded bg-muted/60 text-muted-foreground"
              >
                {l}
              </span>
            ))}
            {task.labels.length > 3 && (
              <span className="text-[9.5px] text-muted-foreground">+{task.labels.length - 3}</span>
            )}
          </div>
        )}

        {/* Options: priority / worktree / auto-approve */}
        {hasOptions && (
          <div className="flex items-center gap-3 flex-wrap pt-1 border-t border-border/50 mb-1.5">
            <PriorityOpt priority={task.priority} />
            {task.isolated_worktree && (
              <span className="flex items-center gap-0.5 text-[9.5px] text-secondary">
                <GitBranch className="w-2.5 h-2.5" />
                worktree
              </span>
            )}
            {task.auto_approve && (
              <span className="flex items-center gap-0.5 text-[9.5px] text-warning">
                <ShieldAlert className="w-2.5 h-2.5" />
                auto-approve
              </span>
            )}
          </div>
        )}

        {/* Footer CTAs */}
        <FooterCTAs
          task={task}
          activeSession={activeSession}
          isAwaiting={isAwaiting}
          isExecuting={isExecuting}
          onExecute={() => void handleExecute(task)}
          onStop={() => interruptTask.mutate(task.id)}
          onJoin={() => navigate({ agentId: String(task.id) })}
          onReview={() => onReviewClick?.(task.id, task.title)}
          onArchive={() => archiveTask.mutate(task.id)}
        />
      </div>
      <DirtyWorktreeDialog
        open={dirtyDialogOpen}
        modifiedCount={dirtyModifiedCount}
        untrackedCount={dirtyUntrackedCount}
        onChoice={onDirtyChoice}
        onCancel={onDirtyCancel}
      />
    </>
  );
}
