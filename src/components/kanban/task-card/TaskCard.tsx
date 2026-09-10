import { memo, useRef, useEffect, useState } from "react";
import { Task, TaskStatus, type JsonValue } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import {
  useBoardActionsContext,
  useTaskSession,
  useTaskWorktree,
} from "@/contexts/BoardActionsContext";
import { useTaskHold } from "@/hooks/useTaskHold";
import { ProposalGate } from "./ProposalGate";
import { PlanGate } from "./PlanGate";
import { TaskProfilesDialog } from "./TaskProfilesDialog";
import { FooterCTAs } from "./FooterCTAs";
import { TaskCardDialogs, type CardDialog } from "./TaskCardDialogs";
import {
  PHASE_LABELS,
  USER_GATE_LABELS,
  PHASE_STATUS_RING,
  COMPLETION_LABELS,
  CI_LABELS,
  CI_TONES,
} from "./phase-labels";
import {
  useInterruptTaskMutation,
  useArchiveTaskMutation,
  useSendTaskToReviewMutation,
} from "@/services/task.service";
import { useRecoverTaskSessionMutation } from "@/services/execution.service";
import { useDeleteWorktreeMutation } from "@/services/worktree.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { useBoardStore, useBoardActions, useAuthRequiredTask } from "@/store/boardStore";
import { api } from "@/lib/tauri-utils";
import { commands } from "@/types/bindings";
import { Flame, ArrowUp, Minus, ArrowDown, GitBranch, ExternalLink } from "lucide-react";
import { useSortable } from "@dnd-kit/react/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useSessionActivity, type SessionActivityInfo } from "@/store/sessionActivityStore";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { ACTIVITY_TEXT, ElapsedTime } from "@/components/execution/shared/activityStatus";
import { openUrl } from "@tauri-apps/plugin-opener";

interface TaskCardProps {
  task: Task;
  index: number;
  dndGroup?: TaskStatus;
}

/// The issue this card was imported from, on the tracker it came from. `openUrl` rather than an
/// anchor because the card itself is clickable — the click has to be stopped before it opens the
/// task detail screen underneath.
function ExternalIdLink({ externalId, url }: { externalId?: string | null; url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open ${externalId ?? "this issue"} in the issue tracker`}
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(url);
            }}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ExternalLink className="size-4" />
      </TooltipTrigger>
      <TooltipContent>Open in the issue tracker</TooltipContent>
    </Tooltip>
  );
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

function CompletionLine({ task }: { task: Task }) {
  const label = task.completion ? COMPLETION_LABELS[task.completion] : undefined;
  if (!label) return null;

  return (
    <div className="flex items-center gap-1 mb-1.5 min-w-0 text-[10px]">
      <span className="font-bold shrink-0 uppercase tracking-wide text-warning">{label}</span>
    </div>
  );
}

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

function TaskCardImpl({ task, index, dndGroup }: TaskCardProps) {
  const { projectId } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();
  const { openReview, clearAuthRequired, setAuthTerminalIdle, clearPendingAuthRetry } =
    useBoardActions();
  const pendingAuthRetry = useBoardStore((s) => s.pendingAuthRetry);
  const authRequired = useAuthRequiredTask(task.id);
  // One value rather than four booleans: only one confirmation can be up, and independent flags
  // could describe a state the card has no rendering for. `abandon` guards deleting the worktree
  // and its branch; `archive` guards putting unmerged work out of sight (D36).
  const [dialog, setDialog] = useState<CardDialog>(null);
  const closeDialog = () => setDialog(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  // The board's, not the card's: one instance of `useExecuteTask` and one of each list query serve
  // every card, and the two dialogs `execute` drives are mounted once by the provider.
  const { execute: handleExecute, executingTaskId, canRefine } = useBoardActionsContext();
  const isExecuting = executingTaskId === task.id;
  const interruptTask = useInterruptTaskMutation();
  const sendToReview = useSendTaskToReviewMutation();
  const archiveTask = useArchiveTaskMutation();
  const deleteWorktree = useDeleteWorktreeMutation();
  // Only read for the unmerged-archive confirmation below.
  const taskWorktree = useTaskWorktree(task.id);
  const recoverSession = useRecoverTaskSessionMutation();
  // Not gated on InProgress: a task keeps its session into Review, which is what the Join button
  // there is for — while this was gated that button could never render. Everything below that
  // should stay InProgress-only carries its own check.
  const activeSession = useTaskSession(task.id);
  const activityInfo = useSessionActivity(activeSession?.session_key);

  useEffect(() => {
    if (pendingAuthRetry !== task.id) return;
    clearPendingAuthRetry();
    if (activeSession) {
      void api.discardFailedSpawn(activeSession.session_key);
    }
    void handleExecute(task, { canPickAgent: true });
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
              <ExternalIdLink externalId={task.external_id} url={task.external_url} />
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
          hasActiveSession={!!activeSession}
          isExecuting={isExecuting}
          canRefine={canRefine}
          isAuthRequired={!!authRequired}
          isRecovering={recoverSession.isPending}
          isSendingToReview={sendToReview.isPending}
          actions={{
            // The one Execute the user presses themselves, and so the only one that asks whether
            // the host has room. The auth retries below are continuations of a start that already
            // passed that gate.
            onExecute: () =>
              void handleExecute(task, { respectCapacity: true, canPickAgent: true }),
            // Refinement runs in the project root and writes nothing, so it does not compete for a
            // slot the way an implementation does and is not deferred against the limit.
            onRefine: () => void handleExecute(task, { role: "Refiner", canPickAgent: true }),
            onOpenProposal: () => setProposalOpen(true),
            onOpenPlan: () => setPlanOpen(true),
            onOpenProfiles: () => setProfilesOpen(true),
            onStop: () => setDialog("abandon"),
            onJoin: () => navigate({ agentId: String(task.id) }),
            onReview: () => openReview(task.id),
            // Every other completion is finished business. `LocalOnly` is the one that leaves
            // something behind, so archiving it silently would put unmerged work out of sight.
            onArchive: () =>
              task.completion === "LocalOnly" ? setDialog("archive") : archiveTask.mutate(task.id),
            onLogin: () => setDialog("auth"),
            onRecover: () => recoverSession.mutate({ taskId: task.id, projectId }),
            onSendToReview: () =>
              sendToReview.mutate(
                { taskId: task.id },
                // Null means the backend found no changes and declined to move it. Confirm rather
                // than force silently: an empty review is the state the pipeline exists to avoid.
                { onSuccess: (moved) => moved === null && setDialog("emptyReview") },
              ),
          }}
        />
      </div>
      <ProposalGate task={task} open={proposalOpen} onOpenChange={setProposalOpen} />
      <PlanGate
        task={task}
        open={planOpen}
        onOpenChange={setPlanOpen}
        // Explicitly the coder: `execute` routes a standing start through the planner when the
        // project has one, and approving a plan is the one case that must not.
        onApprove={() => void handleExecute(task, { role: "Coder", canPickAgent: true })}
        onReplan={(feedback) =>
          void handleExecute(task, { role: "Planner", feedback, canPickAgent: true })
        }
      />
      <TaskProfilesDialog
        task={task}
        projectId={projectId}
        open={profilesOpen}
        onOpenChange={setProfilesOpen}
      />
      <TaskCardDialogs
        task={task}
        dialog={dialog}
        onClose={closeDialog}
        authRequired={authRequired ?? null}
        sessionKey={activeSession?.session_key ?? null}
        taskWorktree={taskWorktree}
        projectId={projectId}
        actions={{
          onAbandon: () => interruptTask.mutate(task.id),
          onArchive: () => archiveTask.mutate(task.id),
          onArchiveAndRemoveWorktree: (worktree) =>
            deleteWorktree.mutate(
              {
                projectId: projectId!,
                worktreePath: worktree.path,
                branchName: worktree.branch_name,
                worktreeId: worktree.id,
                deleteBranch: false,
              },
              { onSuccess: () => archiveTask.mutate(task.id) },
            ),
          onForceReview: () => sendToReview.mutate({ taskId: task.id, force: true }),
          onAuthSuccess: () => {
            // Clearing the store unmounts the modal on its own, but the card's own dialog value
            // has to be reset too — left at "auth", the next time this task needed credentials
            // the modal would already be open before anything asked for it.
            closeDialog();
            clearAuthRequired(task.id);
            // The prompt the agent never got to answer, replayed on the session that is still
            // there. With no session there is nothing to replay it on, so the task starts again.
            if (authRequired?.lastPrompt && activeSession) {
              void api.sendAcpPromptStructured(
                activeSession.session_key,
                authRequired.lastPrompt as JsonValue,
              );
              navigate({ agentId: String(task.id) });
            } else {
              void handleExecute(task, { canPickAgent: true });
            }
          },
          onAuthRetry: () => {
            if (authRequired?.terminalId) {
              void commands.acpAbortAuthTerminal(authRequired.connection);
            }
            setAuthTerminalIdle(task.id);
          },
        }}
      />
    </>
  );
}

/// Memoized because the board renders one of these per task and `tasks` is refetched whole.
///
/// Worth it only now that the card holds no cross-card subscription of its own: while it mounted
/// the session list itself, every ten-second poll re-rendered every card from the inside and no
/// prop comparison could have stopped it.
export const TaskCard = memo(TaskCardImpl);
