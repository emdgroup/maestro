import { useEffect, useState } from "react";
import { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Play,
  Square,
  GitPullRequest,
  ScanEye,
  Archive,
  MessageSquare,
  BotMessageSquare,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
  ListChecks,
} from "lucide-react";

/**
 * What each control on the card does. One object rather than twelve props: the card supplies all
 * of them together and none is meaningful on its own.
 */
export interface FooterActions {
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

interface FooterCTAsProps {
  task: Task;
  /** Only ever read for its truthiness — the footer offers Join, it does not address the session. */
  hasActiveSession: boolean;
  /** The board's, not the task's: whether *this* task is the one mid-spawn. */
  isExecuting: boolean;
  /** Whether any role on the project can run a refinement at all. */
  canRefine: boolean;
  isAuthRequired: boolean;
  isRecovering: boolean;
  isSendingToReview: boolean;
}

export function FooterCTAs({
  task,
  hasActiveSession,
  isExecuting,
  canRefine,
  isAuthRequired,
  isRecovering,
  isSendingToReview,
  actions: {
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
  },
}: FooterCTAsProps & { actions: FooterActions }) {
  /**
   * The agent is waiting on the user rather than working. Derived here rather than passed: it is
   * a reading of the task, and the card had nothing to add to it.
   */
  const isAwaiting = task.phase_status === "Blocked";
  /**
   * The pipeline has stopped for a reason the user can act on — which is the only time there is
   * anything to send on. While it is genuinely working there is no finished work to move.
   */
  const isStuck =
    task.phase_status === "Waiting" ||
    task.phase_status === "Blocked" ||
    task.phase_status === "Failed";

  const base =
    "flex-1 flex items-center justify-center gap-1 text-[10px] font-bold py-2 rounded-full border border-border bg-primary-foreground text-primary hover:bg-muted disabled:opacity-50";

  // Debounced by 2s: `sessions-changed` and `tasks-changed` do not arrive together, so mid-spawn a
  // task reads as InProgress with no session behind it and would flash "session lost".
  const isSessionLost = task.status === "InProgress" && !hasActiveSession;
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
          {hasActiveSession && (
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
        {hasActiveSession && (
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
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onRefine();
              }}
              disabled={isExecuting || !canRefine}
              variant="ghost"
              className={cn(base, "h-auto")}
            >
              <Sparkles className="w-2.5 h-2.5" />
              Refine
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {canRefine
              ? "Ask an agent to sharpen this task's description"
              : "No agent can refine this task. Add a Refinement profile in Settings."}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenProfiles();
                }}
                variant="ghost"
                className={cn(base, "h-auto")}
              />
            }
          >
            <SlidersHorizontal className="w-2.5 h-2.5" />
            Agents
          </TooltipTrigger>
          <TooltipContent>Choose which agent runs each stage of this task</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (task.status === "Queue") {
    // A claimed task keeps its column, so `Spawning` is the only thing distinguishing a task
    // waiting to start from one already starting. Offering Execute again would be a second click
    // the backend refuses — visible to the user only as a button that does nothing.
    const starting = task.phase === "Spawning" && task.phase_status !== "Failed";

    // A failed spawn keeps the claim so the card can show it, and this is the retry. A
    // deferred task keeps the button too, so a user who has just freed a slot can take it
    // rather than waiting for the next drain.
    const executeHint =
      task.phase_status === "Failed"
        ? "Try starting this task again"
        : task.execute_requested_at
          ? "Waiting for a free agent, press to try now"
          : null;

    const executeButton = (
      <Button
        onClick={(e) => {
          e.stopPropagation();
          onExecute();
        }}
        disabled={isExecuting || starting}
        variant="ghost"
        className={cn(base, "h-auto")}
      >
        <Play className="w-2.5 h-2.5 fill-current" />
        {isExecuting || starting
          ? "Starting…"
          : task.phase_status === "Failed"
            ? "Retry"
            : "Execute"}
      </Button>
    );

    return (
      <div className="flex gap-1 mt-1.5">
        {executeHint === null ? (
          executeButton
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {executeButton}
            </TooltipTrigger>
            <TooltipContent>{executeHint}</TooltipContent>
          </Tooltip>
        )}
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onSendToReview();
              }}
              disabled={isSendingToReview}
              variant="ghost"
              aria-label="Send to review"
              className={cn(base, "h-auto")}
            />
          }
        >
          <ScanEye className="w-2.5 h-2.5" />
          Review
        </TooltipTrigger>
        <TooltipContent>
          Move this task to review without waiting for the agent to finish
        </TooltipContent>
      </Tooltip>
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
                variant="ghost"
                className={cn(base, "h-auto bg-foreground text-background")}
              />
            }
          >
            <Square className="w-2.5 h-2.5 fill-current" />
            Abandon
          </TooltipTrigger>
          <TooltipContent>Discard this run and return the task to Planning</TooltipContent>
        </Tooltip>
        {hasActiveSession && (
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
        {hasActiveSession && (
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
