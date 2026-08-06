import { useRef, useEffect, useState } from "react";
import { Task, TaskStatus, TaskPhase, PhaseStatus } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { Button, buttonVariants } from "@/ui/button";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { useTaskHold } from "@/hooks/useTaskHold";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import {
  useInterruptTaskMutation,
  useArchiveTaskMutation,
  useSendTaskToReviewMutation,
} from "@/services/task.service";
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
  AlertTriangle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { useSortable } from "@dnd-kit/react/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { cn } from "@/lib/utils.ts";
import { useSessionActivity, type SessionActivityInfo } from "@/store/sessionActivityStore";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { ACTIVITY_TEXT, ElapsedTime } from "@/components/execution/shared/activityStatus";

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

const PHASE_LABELS: Record<TaskPhase, string> = {
  Spawning: "Starting",
  Refining: "Refining",
  Drafting: "Planning",
  PlanReview: "Plan review",
  Implementing: "Implementing",
  Rework: "Rework",
  SelfReview: "Self review",
  Approval: "Approval",
  AwaitingMerge: "Awaiting merge",
};

/// Three intensities, keyed on `phase_status`. Only `Blocked` animates: it is the one case where
/// an agent is stopped dead waiting on the user. Spreading the pulse across every card the user
/// owns — including a review gate untouched for days — is what would turn it into wallpaper.
///
/// These read apart only because the card's own border is neutral; they each take over the border
/// rather than sitting outside a coloured one.
const PHASE_STATUS_RING: Partial<Record<PhaseStatus, string>> = {
  Blocked: "animate-glow-warning border-warning",
  Waiting: "border-accent ring-1 ring-accent/40",
  Failed: "border-destructive ring-1 ring-destructive/40",
};

/// Only shown when it says something the column does not. A merged task is finished and Done
/// already conveys that; `LocalOnly` means the changes are still sitting in a worktree, and
/// `NoChanges` means the agent finished empty-handed — both are things the user has to be told,
/// because neither is what "Done" implies on its own.
const COMPLETION_LABELS: Partial<Record<NonNullable<Task["completion"]>, string>> = {
  LocalOnly: "not merged",
  NoChanges: "no changes",
};

function CompletionLine({ task }: { task: Task }) {
  const label = task.completion ? COMPLETION_LABELS[task.completion] : undefined;
  if (!label) return null;

  return (
    <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
      <span className="font-bold shrink-0 uppercase tracking-wide text-warning">{label}</span>
    </div>
  );
}

function PhaseLine({ task }: { task: Task }) {
  // A deferred task has no phase — nothing is running — but it is not idle either. The user pressed
  // Execute and was told it would start when an agent freed up, and without this the card is
  // indistinguishable from one nobody has touched.
  if (!task.phase && task.execute_requested_at) {
    return (
      <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
        <span className="font-bold shrink-0 uppercase tracking-wide text-muted-foreground">
          Waiting for a slot
        </span>
      </div>
    );
  }
  if (!task.phase) return <CompletionLine task={task} />;
  const failed = task.phase_status === "Failed";
  return (
    <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
      <span
        className={cn(
          "font-bold shrink-0 uppercase tracking-wide",
          failed
            ? "text-destructive"
            : task.ball === "User"
              ? "text-accent"
              : "text-muted-foreground",
        )}
      >
        {PHASE_LABELS[task.phase]}
        {failed && " · failed"}
      </span>
    </div>
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
  isStuck: boolean;
  isSendingToReview: boolean;
  onExecute: () => void;
  onStop: () => void;
  onJoin: () => void;
  onReview: () => void;
  onArchive: () => void;
  onLogin: () => void;
  onRecover: () => void;
  onSendToReview: () => void;
}

function FooterCTAs({
  task,
  activeSession,
  isAwaiting,
  isExecuting,
  isAuthRequired,
  isRecovering,
  isStuck,
  isSendingToReview,
  onExecute,
  onStop,
  onJoin,
  onReview,
  onArchive,
  onLogin,
  onRecover,
  onSendToReview,
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

  // Planning is where Stop parks a task, so without Execute here a stopped task could only be
  // restarted by first dragging it to Queue — a step that means nothing to the user and exists
  // only because this branch used to be Queue-only.
  if (task.status === "Planning" || task.status === "Queue") {
    // A claimed task keeps its column, so `Spawning` is the only thing distinguishing a task
    // waiting to start from one already starting. Offering Execute again would be a second click
    // the backend refuses — visible to the user only as a button that does nothing.
    const starting = task.phase === "Spawning" && task.phase_status !== "Failed";

    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onExecute();
          }}
          disabled={isExecuting || starting}
          variant="ghost"
          className={cn(base, "h-auto")}
          // A failed spawn keeps the claim so the card can show it, and this is the retry. A
          // deferred task keeps the button too, so a user who has just freed a slot can take it
          // rather than waiting for the next drain.
          title={
            task.phase_status === "Failed"
              ? "Try starting this task again"
              : task.execute_requested_at
                ? "Waiting for a free agent — press to try now"
                : undefined
          }
        >
          <Play className="w-2.5 h-2.5 fill-current" />
          {isExecuting || starting
            ? "Starting…"
            : task.phase_status === "Failed"
              ? "Retry"
              : "Execute"}
        </Button>
      </div>
    );
  }

  if (task.status === "InProgress") {
    // Only offered when the pipeline is stuck — the agent is waiting, blocked or has failed.
    // While it is genuinely working there is nothing to send on yet. Declared before the early
    // returns below because a dead session is exactly when this is needed: the work may well be
    // finished and only the session gone.
    const sendToReview = isStuck && (
      <Button
        onClick={(e) => {
          e.stopPropagation();
          onSendToReview();
        }}
        disabled={isSendingToReview}
        variant="ghost"
        className={cn(base, "h-auto")}
        title="Move this task to review without waiting for the agent to finish"
      >
        <GitPullRequest className="w-2.5 h-2.5" />
        Review
      </Button>
    );

    if (sessionLostStable) {
      return (
        <div className="flex flex-col gap-1 mt-1.5">
          {/* When the phase already says it failed, this line would just say it again. */}
          {task.phase_status !== "Failed" && (
            <p className="text-[10px] font-bold text-destructive text-center">Session lost</p>
          )}
          <div className="flex gap-1">
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
            {sendToReview}
          </div>
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
          {sendToReview}
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
          title="Discard this run and return the task to Planning"
        >
          <Square className="w-2.5 h-2.5 fill-current" />
          Abandon
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
        {sendToReview}
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
  const [emptyReviewConfirmOpen, setEmptyReviewConfirmOpen] = useState(false);
  // Abandoning deletes the worktree and its branch, so it cannot be a bare click on a card.
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
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
  const sendToReview = useSendTaskToReviewMutation();
  const archiveTask = useArchiveTaskMutation();
  const recoverSession = useRecoverTaskSessionMutation();
  // Not gated on InProgress: a task keeps its session into Review, which is what the Join button
  // there is for — while this was gated that button could never render. Everything below that
  // should stay InProgress-only carries its own check.
  const activeSession = useTaskActiveSession(task.id, projectId);
  const activityInfo = useSessionActivity(activeSession?.session_key);
  // Read from the task rather than from live session activity, so it survives a reload. The
  // activity line below stays live: it is finer-grained than the phase and still worth having.
  const isAwaiting = task.phase_status === "Blocked";

  useEffect(() => {
    if (pendingAuthRetry !== task.id) return;
    clearPendingAuthRetry();
    if (activeSession) {
      void api.discardFailedSpawn(activeSession.session_key);
    }
    void handleExecute(task);
  }, [pendingAuthRetry, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDraggable = task.status === "Planning" || task.status === "Queue";

  const { ref, isDragging } = useSortable({
    id: task.id,
    index,
    type: "item",
    accept: ["item"],
    group: dndGroup ?? task.status,
    disabled: !isDraggable,
    collisionDetector: pointerIntersection,
  });

  // A card dropped somewhere it can be started is a card the scheduler could claim mid-gesture,
  // which would yank it out from under the pointer.
  useTaskHold(task.id, isDragging);

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

  const hasOptions = task.priority !== "None" || task.isolated_worktree || task.auto_approve;

  return (
    <>
      <div
        ref={ref}
        // The border is deliberately neutral. It used to repeat the column's own colour, which
        // said nothing the card's position did not already say, and it spent the one piece of
        // colour the card has: with an amber border in an amber column, an amber "waiting" ring
        // and an amber "blocked" glow were indistinguishable from each other and from the card
        // itself. Status is the column; the border belongs to the pipeline state.
        className={cn(
          "rounded-lg border border-border p-2.5 mb-2 flex flex-col transition-all",
          "hover:shadow-md",
          task.phase_status && PHASE_STATUS_RING[task.phase_status],
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

        {/* Pipeline phase — persisted, so it renders with or without a live session */}
        <PhaseLine task={task} />

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
          isStuck={
            task.phase_status === "Waiting" ||
            task.phase_status === "Blocked" ||
            task.phase_status === "Failed"
          }
          isSendingToReview={sendToReview.isPending}
          // The one Execute the user presses themselves, and so the only one that asks whether
          // the host has room. The auth retries below are continuations of a start that already
          // passed that gate.
          onExecute={() => void handleExecute(task, { respectCapacity: true })}
          onStop={() => setAbandonConfirmOpen(true)}
          onJoin={() => navigate({ agentId: String(task.id) })}
          onReview={() => openReview(task.id)}
          onArchive={() => archiveTask.mutate(task.id)}
          onLogin={() => setIsAuthModalOpen(true)}
          onRecover={() => recoverSession.mutate({ taskId: task.id, projectId })}
          onSendToReview={() =>
            sendToReview.mutate(
              { taskId: task.id },
              // Null means the backend found no changes and declined to move it. Confirm rather
              // than force silently: an empty review is the state the pipeline exists to avoid.
              { onSuccess: (task) => setEmptyReviewConfirmOpen(task === null) },
            )
          }
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
      <AlertDialog open={abandonConfirmOpen} onOpenChange={setAbandonConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Abandon this run?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The agent stops and everything it produced is deleted — the worktree, its branch and
              any uncommitted work in it. The task itself returns to Planning with its description
              intact, as though it had never run. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => interruptTask.mutate(task.id)}
            >
              Abandon
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={emptyReviewConfirmOpen} onOpenChange={setEmptyReviewConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Nothing to review
            </AlertDialogTitle>
            <AlertDialogDescription>
              This task has not changed any files since the agent started, so its review will be
              empty. Send it to review anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => sendToReview.mutate({ taskId: task.id, force: true })}
            >
              Review anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
