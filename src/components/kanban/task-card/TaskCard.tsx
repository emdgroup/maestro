import { useRef, useEffect, useMemo, useState, CSSProperties } from "react";
import { Task, TaskStatus } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { Button } from "@/ui/button";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import { useInterruptTaskMutation, useArchiveTaskMutation } from "@/services/task.service";
import { useRecoverTaskSessionMutation } from "@/services/execution.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { useBoardStore, useBoardActions, useAuthRequiredTask } from "@/store/boardStore";
import { AgentAuthModal } from "@/components/common/AgentAuthModal";
import { api } from "@/lib/tauri-utils";
import { commands } from "@/types/bindings";
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
  LockKeyhole,
  RefreshCw,
} from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { cn } from "@/lib/utils.ts";
import { useSessionActivity, type SessionActivityInfo } from "@/store/sessionActivityStore";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { ACTIVITY_TEXT, ElapsedTime } from "@/components/execution/shared/activityStatus";
import { colors } from "@/components/kanban/kanban-column/KanbanColumn.tsx";

interface TaskCardProps {
  task: Task;
  index: number;
  dndGroup?: TaskStatus;
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
  isAuthRequired: boolean;
  isRecovering: boolean;
  onExecute: () => void;
  onStop: () => void;
  onJoin: () => void;
  onReview: () => void;
  onArchive: () => void;
  onLogin: () => void;
  onRecover: () => void;
}

function FooterCTAs({
  task,
  activeSession,
  isAwaiting,
  isExecuting,
  isAuthRequired,
  isRecovering,
  onExecute,
  onStop,
  onJoin,
  onReview,
  onArchive,
  onLogin,
  onRecover,
}: FooterCTAsProps) {
  const base =
    "flex-1 flex items-center justify-center gap-1 text-[10px] font-bold py-2 rounded-full border border-border bg-primary-foreground text-primary hover:bg-muted disabled:opacity-50";

  // ponytail: 2s debounce avoids flashing "session lost" during spawn race between sessions-changed and tasks-changed
  const isSessionLost = task.status === "InProgress" && !activeSession;
  const [sessionLostStable, setSessionLostStable] = useState(false);
  useEffect(() => {
    if (!isSessionLost) {
      setSessionLostStable(false);
      return;
    }
    const t = setTimeout(() => setSessionLostStable(true), 2000);
    return () => clearTimeout(t);
  }, [isSessionLost]);

  if (task.status === "Ready") {
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onExecute();
          }}
          disabled={isExecuting}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <Play className="w-2.5 h-2.5 fill-current" />
          {isExecuting ? "Starting…" : "Execute"}
        </Button>
      </div>
    );
  }

  if (task.status === "InProgress") {
    if (sessionLostStable) {
      return (
        <div className="flex flex-col gap-1 mt-1.5">
          <p className="text-[10px] font-bold text-destructive text-center">Session lost</p>
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onRecover();
            }}
            disabled={isRecovering}
            variant="ghost"
            className={cn(base, "h-auto")}
          >
            <RefreshCw className="w-2.5 h-2.5" />
            {isRecovering ? "Recovering…" : "Recover"}
          </Button>
        </div>
      );
    }
    if (isAuthRequired) {
      return (
        <div className="flex gap-1 mt-1.5">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onLogin();
            }}
            variant="ghost"
            className={cn(base, "h-auto border-warning/50 text-warning hover:bg-warning/10")}
          >
            <LockKeyhole className="w-2.5 h-2.5" />
            Login
          </Button>
        </div>
      );
    }
    if (isAwaiting) {
      return (
        <div className="flex gap-1 mt-1.5">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            variant="ghost"
            className={cn(base, "h-auto")}
          >
            <MessageSquare className="w-2.5 h-2.5 fill-current" />
            Respond
          </Button>
        </div>
      );
    }
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          variant="ghost"
          className={cn(base, "h-auto bg-foreground text-background")}
        >
          <Square className="w-2.5 h-2.5 fill-current" />
          Stop
        </Button>
        {activeSession && (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            variant="ghost"
            className={cn(base, "h-auto")}
          >
            <BotMessageSquare className="w-2.5 h-2.5" />
            Join
          </Button>
        )}
      </div>
    );
  }

  if (task.status === "Review") {
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onReview();
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <GitPullRequest className="w-2.5 h-2.5" />
          Review
        </Button>
        {activeSession && (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            variant="ghost"
            className={cn(base, "h-auto")}
          >
            <BotMessageSquare className="w-2.5 h-2.5" />
            Join
          </Button>
        )}
      </div>
    );
  }

  if (task.status === "Done" && !task.archived_at) {
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          variant="ghost"
          className={cn(base, "h-auto bg-foreground text-background")}
        >
          <Archive className="w-2.5 h-2.5" />
          Archive
        </Button>
      </div>
    );
  }

  return null;
}

export function TaskCard({ task, index, dndGroup }: TaskCardProps) {
  const { projectId, projectPath, connection } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();
  const { openReview, clearAuthRequired, setAuthTerminalIdle, clearPendingAuthRetry } =
    useBoardActions();
  const pendingAuthRetry = useBoardStore((s) => s.pendingAuthRetry);
  const authRequired = useAuthRequiredTask(task.id);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
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
  const recoverSession = useRecoverTaskSessionMutation();
  const activeSession = useTaskActiveSession(
    task.status === "InProgress" ? task.id : null,
    projectId,
  );
  const activityInfo = useSessionActivity(activeSession?.session_key);
  const activityStatus = activityInfo?.status ?? null;
  const isAwaiting = task.status === "InProgress" && activityStatus === "awaiting_input";

  useEffect(() => {
    if (pendingAuthRetry !== task.id) return;
    clearPendingAuthRetry();
    if (activeSession) {
      void api.discardFailedSpawn(activeSession.session_key);
    }
    void handleExecute(task);
  }, [pendingAuthRetry, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          } as CSSProperties
        }
        className={cn(
          "rounded-lg border p-2.5 mb-2 flex flex-col transition-all border-(--card-color)",
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
          isAuthRequired={!!authRequired}
          isRecovering={recoverSession.isPending}
          onExecute={() => void handleExecute(task)}
          onStop={() => interruptTask.mutate(task.id)}
          onJoin={() => navigate({ agentId: String(task.id) })}
          onReview={() => openReview(task.id)}
          onArchive={() => archiveTask.mutate(task.id)}
          onLogin={() => setIsAuthModalOpen(true)}
          onRecover={() => recoverSession.mutate({ taskId: task.id, projectId })}
        />
      </div>
      {authRequired && (
        <AgentAuthModal
          agentId={authRequired.agentId}
          agentName={authRequired.agentId}
          connection={authRequired.connection}
          open={isAuthModalOpen}
          taskId={task.id}
          sessionKey={activeSession?.session_key ?? null}
          terminalState={authRequired.terminalState}
          onAuthSuccess={() => {
            setIsAuthModalOpen(false);
            clearAuthRequired(task.id);
            if (authRequired.lastPrompt && activeSession) {
              void api.sendAcpPromptStructured(
                activeSession.session_key,
                authRequired.lastPrompt as import("@/types/bindings").JsonValue,
              );
              navigate({ agentId: String(task.id) });
            } else {
              void handleExecute(task);
            }
          }}
          onClose={() => setIsAuthModalOpen(false)}
          onRetry={() => {
            if (authRequired.terminalId) {
              void commands.acpAbortAuthTerminal(authRequired.connection);
            }
            setAuthTerminalIdle(task.id);
          }}
        />
      )}
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
