import { useState } from "react";
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
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import { usePullWorktreeMutation, usePushWorktreeMutation } from "@/services/worktree.service";
import type { WorktreeWithStatus } from "@/types/bindings";

/** One of the two chips. `count` is always above zero when `show` is true. */
export interface SyncAction {
  show: boolean;
  /** Commits this direction would move, and the number printed on the chip. */
  count: number;
  /** Tooltip text. */
  reason: string;
}

export interface SyncActions {
  push: SyncAction;
  pull: SyncAction;
  /** True when the push would also create the branch on the remote. Changes wording, not the chip. */
  publish: boolean;
}

const HIDDEN: SyncAction = { show: false, count: 0, reason: "" };

/**
 * What the two chips do for one worktree.
 *
 * Pure, so the state matrix is testable without rendering. The single rule behind it: **a chip
 * exists only when it has commits to move.** Nothing to push and nothing to pull means no controls
 * at all, which is what keeps a settled worktree reading exactly as it did before this feature —
 * the counts on the card were already the whole story, and a control that would do nothing is
 * noise on every card in the grid.
 *
 * Two cases fall out of that rule rather than needing their own:
 *
 * A detached worktree has no branch, so neither direction has anything to move. The branch line
 * above already reads `detached at <sha>` in warning colour and would only be repeated.
 *
 * `ahead_behind` is `null` exactly when the branch has no upstream. A push there would create the
 * branch, and what it would send is the branch's own commits — `commit_count`, which the card
 * already counts against the base branch. A brand-new branch with no commits of its own is worth
 * nothing on the remote, so it gets no chip either.
 */
export function syncActions(worktree: WorktreeWithStatus, inUse: boolean): SyncActions {
  if (worktree.detached_at != null) {
    return { push: HIDDEN, pull: HIDDEN, publish: false };
  }

  const dirty = worktree.changed_files_count;
  const uncommitted =
    dirty > 0 ? ` ${dirty} uncommitted file${dirty === 1 ? "" : "s"} will not be included.` : "";
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

  if (worktree.ahead_behind == null) {
    const ahead = worktree.commit_count ?? 0;
    return {
      push:
        ahead > 0
          ? {
              show: true,
              count: ahead,
              reason: `Push ${commits(ahead)} and create this branch on the remote.${uncommitted}`,
            }
          : HIDDEN,
      pull: HIDDEN,
      publish: true,
    };
  }

  const { ahead, behind } = worktree.ahead_behind;
  return {
    push:
      ahead > 0
        ? {
            show: true,
            count: ahead,
            reason: `Push ${commits(ahead)} to the remote.${uncommitted}`,
          }
        : HIDDEN,
    pull:
      behind > 0
        ? {
            show: true,
            count: behind,
            reason: inUse
              ? `Fast-forward past ${commits(behind)}. Something is running here, so this will ask first.`
              : `Fast-forward past ${commits(behind)} from the remote.`,
          }
        : HIDDEN,
    publish: false,
  };
}

/** Whether this worktree has anything to offer, so the card knows not to pass an empty slot. */
export function hasSyncActions(worktree: WorktreeWithStatus): boolean {
  const actions = syncActions(worktree, false);
  return actions.push.show || actions.pull.show;
}

interface WorktreeSyncActionsProps {
  worktree: WorktreeWithStatus;
  projectId: number;
  /** From `isInUse` — a live agent or shell makes a pull ask before rewriting files under it. */
  inUse: boolean;
}

/**
 * Push and pull, rendered as the metrics row's own ahead/behind counts.
 *
 * The chips replace the static `↑2 ↓3` segment rather than sitting beside it: the affordance
 * belongs on the number it acts on, and the card gains nothing at rest — the counts were already
 * there, and only pick up a button outline when the card is hovered.
 *
 * Hovering a chip directly widens it to name the verb, because an arrow and a number alone do not
 * read as a control. That grows the chip sideways only: every chip is `h-4`, the line height of
 * the text around it, so the wrapping metrics row never changes height and the card never moves
 * under the cursor.
 */
export function WorktreeSyncActions({ worktree, projectId, inUse }: WorktreeSyncActionsProps) {
  const [confirmPull, setConfirmPull] = useState(false);
  const push = usePushWorktreeMutation();
  const pull = usePullWorktreeMutation();
  const actions = syncActions(worktree, inUse);
  const busy = push.isPending || pull.isPending;

  const runPull = () => pull.mutate({ projectId, worktreePath: worktree.path });

  const chip = (
    action: SyncAction,
    {
      arrow,
      verb,
      label,
      tone,
      pending,
      onClick,
    }: {
      arrow: string;
      verb: string;
      label: string;
      tone: string;
      pending: boolean;
      onClick: () => void;
    },
  ) => {
    if (!action.show) return null;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                onClick();
              }}
              className={cn(
                "h-4 cursor-pointer gap-0.5 rounded px-1 font-mono text-xs",
                // `hover:text-foreground` comes from the ghost variant and drained the colour out
                // of the count the moment the cursor reached it. The chip keeps its own tone.
                tone,
                // The button already carries `border border-transparent`, so colouring it in costs
                // no layout. A `bg-muted` tint alone was tried first and is invisible against the
                // card in the light themes.
                "bg-transparent group-hover:border-border group-hover:bg-muted",
                "hover:border-accent hover:bg-muted",
              )}
            />
          }
        >
          {pending ? <Spinner className="size-3" /> : arrow}
          {action.count}
          {/* The label slides open rather than appearing: a `hidden`/`inline` swap cannot be
              transitioned, because `display` is not an animatable property. Collapsing a grid
              column from `0fr` to `1fr` animates the real width of whatever the verb happens to
              be, with no magic number to keep in step with the text.
              `group/button` is on the button itself, from `buttonVariants`. */}
          <span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-150 ease-out group-hover/button:grid-cols-[1fr] motion-reduce:transition-none">
            <span className="overflow-hidden">
              <span className="pl-1">{verb}</span>
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{action.reason}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
      {chip(actions.push, {
        arrow: "↑",
        verb: "Push",
        label: "Push to remote",
        tone: "text-success hover:text-success",
        pending: push.isPending,
        onClick: () =>
          push.mutate({
            projectId,
            worktreePath: worktree.path,
            branchName: worktree.branch_name,
          }),
      })}
      {chip(actions.pull, {
        arrow: "↓",
        verb: "Pull",
        label: "Pull from remote",
        tone: "text-warning hover:text-warning",
        pending: pull.isPending,
        onClick: () => (inUse ? setConfirmPull(true) : runPull()),
      })}

      <AlertDialog open={confirmPull} onOpenChange={setConfirmPull}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull into a worktree that is in use?</AlertDialogTitle>
            <AlertDialogDescription>
              Something is running in{" "}
              <span className="font-mono font-medium">{worktree.branch_name}</span>. A pull rewrites
              files underneath it, which can corrupt an edit it is part-way through.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmPull(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPull(false);
                runPull();
              }}
            >
              Pull anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
