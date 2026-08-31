import { useRef, useEffect, useState } from "react";
import { Task, TaskStatus, TaskPhase, PhaseStatus } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { Button, buttonVariants } from "@/ui/button";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { useTaskHold } from "@/hooks/useTaskHold";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import { ProposalGate } from "./ProposalGate";
import { PlanGate } from "./PlanGate";
import { TaskProfilesDialog } from "./TaskProfilesDialog";
import {
  useInterruptTaskMutation,
  useArchiveTaskMutation,
  useSendTaskToReviewMutation,
} from "@/services/task.service";
import { useRecoverTaskSessionMutation } from "@/services/execution.service";
import { useWorktreesQuery, useDeleteWorktreeMutation } from "@/services/worktree.service";
import { useAgentProfilesQuery } from "@/services/project.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { useDefaultAgent } from "@/store/configStore";
import { useBoardStore, useBoardActions, useAuthRequiredTask } from "@/store/boardStore";
import { AgentAuthModal } from "@/components/common/AgentAuthModal";
import { api } from "@/lib/tauri-utils";
import { commands } from "@/types/bindings";
import {
  Play,
  Square,
  GitPullRequest,
  ScanEye,
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
  Sparkles,
  SlidersHorizontal,
  ListChecks,
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
import { openUrl } from "@tauri-apps/plugin-opener";

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

/// What the card says instead once the ball is with the user.
///
/// A phase name answers "which stage is this", which is the right question while an agent is
/// working and the wrong one the moment the task is waiting on a person — then the only question is
/// what is being asked of them. `Approval` is the worst of them: it reads as a verdict already
/// delivered, and it appears directly after a reviewer whose message says `APPROVED`. A live run
/// stalled there, with the user reading the card as "this is approved" rather than "approve this".
///
/// Until now the sole signal that a card wanted something was its label being accent-coloured
/// rather than grey, which is a distinction that carries no meaning on its own and none at all to
/// anyone not separating those two colours. The words carry it now; the colour stays as emphasis.
///
/// Deliberately not exhaustive. A phase absent here has no user gate — or, like a `Blocked` agent,
/// already says so through the pulsing border it is the only phase status to get.
const USER_GATE_LABELS: Partial<Record<TaskPhase, string>> = {
  Refining: "Proposal for you",
  PlanReview: "Plan for you",
  Approval: "Needs your approval",
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

const CI_LABELS: Record<NonNullable<Task["pull_request_ci"]>, string> = {
  Passing: "checks passed",
  Failing: "CI failing",
  Pending: "checks running",
};

const CI_TONES: Record<NonNullable<Task["pull_request_ci"]>, string> = {
  Passing: "text-success",
  Failing: "text-destructive",
  Pending: "text-muted-foreground",
};

/// What the forge last said, in the slot the phase name had.
///
/// "Awaiting merge" only ever repeated the column the card is already sitting in. The question at
/// this card is whether the thing being waited on can land, and until now the answer was nowhere:
/// between a red build and the next three-minute sweep, a healthy pull request and a broken one
/// looked identical, which is what made a working sweep read as no sweep at all.
///
/// The conflict is derived rather than stored. `AwaitingMerge` with `Waiting` and the ball on the
/// user is reachable only through `PullRequestConflicted` — `AwaitingUserInput` gives `Blocked` and
/// a closed pull request gives `Failed` — so a cached flag would be a second copy of a fact the
/// lifecycle fields already carry, and one a sweep that learned nothing could overwrite.
function PullRequestLine({ task }: { task: Task }) {
  const conflicted = task.phase_status === "Waiting" && task.ball === "User";
  const ci = task.pull_request_ci;
  const detail = conflicted
    ? { label: "conflicts", tone: "text-warning" }
    : ci
      ? { label: CI_LABELS[ci], tone: CI_TONES[ci] }
      : null;

  return (
    <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
      <span
        className={cn(
          "font-bold shrink-0 uppercase tracking-wide",
          conflicted ? "text-warning" : "text-muted-foreground",
        )}
      >
        {task.pull_request_number ? `PR #${task.pull_request_number}` : PHASE_LABELS.AwaitingMerge}
      </span>
      {detail && (
        <>
          <span className="text-muted-foreground/40 shrink-0">·</span>
          <span className={cn("uppercase tracking-wide truncate", detail.tone)}>
            {detail.label}
          </span>
        </>
      )}
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
  if (task.phase === "AwaitingMerge" && !failed) return <PullRequestLine task={task} />;
  // A pull request somebody closed did not "fail to await merge". It is still the error state
  // D28 asks for — red, ball with the user — but the words have to say what happened.
  const label =
    failed && task.phase === "AwaitingMerge"
      ? "Pull request closed"
      : (!failed && task.ball === "User" && USER_GATE_LABELS[task.phase]) ||
        PHASE_LABELS[task.phase] + (failed ? " · failed" : "");
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
        {label}
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
  canRefine: boolean;
  isAuthRequired: boolean;
  isRecovering: boolean;
  isStuck: boolean;
  isSendingToReview: boolean;
  onExecute: () => void;
  onRefine: () => void;
  onOpenProposal: () => void;
  onOpenPlan: () => void;
  onOpenProfiles: () => void;
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
  canRefine,
  isAuthRequired,
  isRecovering,
  isStuck,
  isSendingToReview,
  onExecute,
  onRefine,
  onOpenProposal,
  onOpenPlan,
  onOpenProfiles,
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
  // The debounce only ever raises the flag, so a session that is no longer lost cannot
  // be stably lost — derived here rather than reset from the effect below.
  const showSessionLost = isSessionLost && sessionLostStable;

  useEffect(() => {
    if (!isSessionLost) return;
    const t = setTimeout(() => setSessionLostStable(true), 2000);
    return () => clearTimeout(t);
  }, [isSessionLost]);

  // Ahead of the Planning branch, which returns Execute unconditionally and so made every other
  // control on a Planning card unreachable — a refiner blocked on a question would have pulsed
  // amber with no way to answer it.
  if (task.phase === "Refining") {
    // The proposal gate. Join is offered alongside because the proposal is a message in a session
    // the user can still talk to — "nearly right, but…" is a conversation, not a rejection.
    if (task.phase_status === "Waiting") {
      return (
        <div className="flex gap-1 mt-1.5">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onOpenProposal();
            }}
            variant="ghost"
            className={cn(base, "h-auto")}
          >
            <MessageSquare className="w-2.5 h-2.5" />
            Read proposal
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

    return (
      <div className="flex gap-1 mt-1.5">
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
            {isAwaiting ? "Respond" : "Join"}
          </Button>
        )}
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <Square className="w-2.5 h-2.5 fill-current" />
          Stop
        </Button>
      </div>
    );
  }

  // Planning shapes a task; Queue runs it. The two used to share this branch and both offered
  // Execute, which made "drag it to Queue" a step that changed nothing — and gave the board two
  // ways to start the same work, only one of which the scheduler knows about.
  //
  // Nothing here can start a task any more. That is the point: a task starts by being in Queue.
  if (task.status === "Planning") {
    return (
      <div className="flex gap-1 mt-1.5">
        {/* Refinement needs an agent to run it, and nothing on this card can conjure one. Left
            enabled, the only thing pressing it produced was a toast about the default agent — an
            answer to a question the user had not asked, on a project whose real problem is that no
            role has a profile yet. */}
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onRefine();
          }}
          disabled={isExecuting || !canRefine}
          variant="ghost"
          className={cn(base, "h-auto")}
          title={
            canRefine
              ? "Ask an agent to sharpen this task's description"
              : "No agent can refine this task. Add a Refinement profile in Settings."
          }
        >
          <Sparkles className="w-2.5 h-2.5" />
          Refine
        </Button>
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onOpenProfiles();
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
          title="Choose which agent runs each stage of this task"
        >
          <SlidersHorizontal className="w-2.5 h-2.5" />
          Agents
        </Button>
      </div>
    );
  }

  if (task.status === "Queue") {
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
                ? "Waiting for a free agent, press to try now"
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

  // The plan gate. Ahead of the In Progress branch, whose first concern is a lost session — and
  // at this gate there is *always* no session, because the planner's is closed the moment its plan
  // is taken. Falling through to that branch is what put "Session lost / Recover" on the card with
  // the finished plan unreachable behind it.
  //
  // Nothing to join here for the same reason. There was a Join button, on the theory that the user
  // might want to question the planner before deciding; the plan is in the thread and the agent
  // that wrote it is gone, so the only way to say something about a plan is to say it at the gate.
  if (task.phase === "PlanReview") {
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onOpenPlan();
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <ListChecks className="w-2.5 h-2.5" />
          Read plan
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
        <ScanEye className="w-2.5 h-2.5" />
        Review
      </Button>
    );

    if (showSessionLost) {
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

  // A task waiting on a pull request has nothing for the user to do here, so the card points at
  // the one place where something can happen. Review stays available beside it — the diff is
  // still worth reading while the PR is open.
  if (task.phase === "AwaitingMerge" && task.pull_request_url) {
    const pullRequestUrl = task.pull_request_url;
    return (
      <div className="flex gap-1 mt-1.5">
        <Button
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(pullRequestUrl);
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <GitPullRequest className="w-2.5 h-2.5" />
          Pull request
          {task.pull_request_number ? ` #${task.pull_request_number}` : ""}
        </Button>
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onReview();
          }}
          variant="ghost"
          className={cn(base, "h-auto")}
        >
          <ScanEye className="w-2.5 h-2.5" />
          Review
        </Button>
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
          <ScanEye className="w-2.5 h-2.5" />
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
  // Archiving a task whose changes were never merged puts unmerged work out of sight (D36).
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
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
  const deleteWorktree = useDeleteWorktreeMutation();
  // Only read for the unmerged-archive confirmation below. The same query key the board already
  // holds, so this subscribes to a cached list rather than fetching one per card.
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath);
  const taskWorktree = (worktrees ?? []).find((w) => w.task_id === task.id) ?? null;
  const recoverSession = useRecoverTaskSessionMutation();
  // Same query key the profiles dialog uses, so every card on the board shares one fetch.
  const { data: profilesDocument } = useAgentProfilesQuery(projectId);
  const defaultAgent = useDefaultAgent();
  // A Refiner profile is how a project opts into refinement; a project default agent is the
  // fallback `useExecuteTask` applies when no profile names one. With neither, there is nothing to
  // start.
  const canRefine =
    (profilesDocument?.profiles ?? []).some((p) => p.role === "Refiner") || !!defaultAgent;
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

  // A drag applies `ManualMove`, which parks the task — wiping the phase and orphaning the session
  // an agent is still working in. Gated on the agent rather than on the phase so a card left at a
  // gate, or one whose spawn failed, can still be moved: those are exactly the states a user needs
  // to drag out of.
  const agentIsWorking = task.phase_status === "Running" || task.phase_status === "Blocked";
  const isDraggable = (task.status === "Planning" || task.status === "Queue") && !agentIsWorking;

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

  const hasOptions = task.priority !== "None" || task.workspace_mode !== "RepositoryDirectory";

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

        {/* Options: priority / workspace */}
        {hasOptions && (
          <div className="flex items-center gap-3 flex-wrap pt-1 border-t border-border/50 mb-1.5">
            <PriorityOpt priority={task.priority} />
            {task.workspace_mode !== "RepositoryDirectory" && (
              <span className="flex items-center gap-0.5 text-[9.5px] text-secondary">
                <GitBranch className="w-2.5 h-2.5" />
                {task.workspace_mode === "ReuseWorkspace" ? "workspace" : "worktree"}
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
          canRefine={canRefine}
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
          // Refinement runs in the project root and writes nothing, so it does not compete for a
          // slot the way an implementation does and is not deferred against the limit.
          onRefine={() => void handleExecute(task, { role: "Refiner" })}
          onOpenProposal={() => setProposalOpen(true)}
          onOpenPlan={() => setPlanOpen(true)}
          onOpenProfiles={() => setProfilesOpen(true)}
          onStop={() => setAbandonConfirmOpen(true)}
          onJoin={() => navigate({ agentId: String(task.id) })}
          onReview={() => openReview(task.id)}
          // Every other completion is finished business. `LocalOnly` is the one that leaves
          // something behind, so archiving it silently would put unmerged work out of sight.
          onArchive={() =>
            task.completion === "LocalOnly"
              ? setArchiveConfirmOpen(true)
              : archiveTask.mutate(task.id)
          }
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
      <ProposalGate task={task} open={proposalOpen} onOpenChange={setProposalOpen} />
      <PlanGate
        task={task}
        open={planOpen}
        onOpenChange={setPlanOpen}
        // Explicitly the coder: `execute` routes a standing start through the planner when the
        // project has one, and approving a plan is the one case that must not.
        onApprove={() => void handleExecute(task, { role: "Coder" })}
        onReplan={(feedback) => void handleExecute(task, { role: "Planner", feedback })}
      />
      <TaskProfilesDialog
        task={task}
        projectId={projectId}
        open={profilesOpen}
        onOpenChange={setProfilesOpen}
      />
      <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              These changes were never merged
            </AlertDialogTitle>
            <AlertDialogDescription>
              {taskWorktree
                ? `The work is committed on ${taskWorktree.branch_name}, and its worktree is still at ${taskWorktree.path}. Archiving takes the task off the board either way. The question is only whether the worktree stays with it.`
                : "The work was committed but never merged into the base branch. Archiving takes the task off the board; the branch stays where it is."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep on the board</AlertDialogCancel>
            {taskWorktree &&
              projectId !== null && (
                // Deletes the checkout, not the branch. The commits are the unmerged work this
                // dialog exists to protect; the working copy of them is just disk.
                <AlertDialogAction
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => {
                    setArchiveConfirmOpen(false);
                    deleteWorktree.mutate(
                      {
                        projectId,
                        worktreePath: taskWorktree.path,
                        branchName: taskWorktree.branch_name,
                        worktreeId: taskWorktree.id,
                        deleteBranch: false,
                      },
                      { onSuccess: () => archiveTask.mutate(task.id) },
                    );
                  }}
                >
                  Archive and remove the worktree
                </AlertDialogAction>
              )}
            <AlertDialogAction
              onClick={() => {
                setArchiveConfirmOpen(false);
                archiveTask.mutate(task.id);
              }}
            >
              Archive, keep everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={abandonConfirmOpen} onOpenChange={setAbandonConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Abandon this run?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The agent stops and everything it produced is deleted: the worktree, its branch and
              any uncommitted work in it. The task itself returns to Planning with its description
              intact, as though it had never run. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            {/* `AlertDialogAction` is a plain button — only `AlertDialogCancel` renders through
                base-ui's `Close`, so an action that does not close the dialog itself leaves it up
                over a task it has already abandoned. Same for the two dialogs below. */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                setAbandonConfirmOpen(false);
                interruptTask.mutate(task.id);
              }}
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
              onClick={() => {
                setEmptyReviewConfirmOpen(false);
                sendToReview.mutate({ taskId: task.id, force: true });
              }}
            >
              Review anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
