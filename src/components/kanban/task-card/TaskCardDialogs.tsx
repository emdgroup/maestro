import { AlertTriangle } from "lucide-react";
import { buttonVariants } from "@/ui/button";
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
import { AgentAuthModal } from "@/components/common/AgentAuthModal";
import type { Task, WorktreeWithStatus } from "@/types/bindings";
import type { AuthRequiredEntry } from "@/store/boardStore";

/// Which confirmation is up. One value rather than four booleans: only one of these can be open,
/// and four independent flags could describe a state the card has no rendering for.
export type CardDialog = "auth" | "abandon" | "archive" | "emptyReview" | null;

/// What each confirmation does once confirmed. The mutations stay with the card, which also fires
/// some of them from the footer — this keeps one instance of each rather than two.
export interface DialogActions {
  onAbandon: () => void;
  onArchive: () => void;
  onArchiveAndRemoveWorktree: (worktree: WorktreeWithStatus) => void;
  onForceReview: () => void;
  onAuthSuccess: () => void;
  onAuthRetry: () => void;
}

interface TaskCardDialogsProps {
  task: Task;
  dialog: CardDialog;
  onClose: () => void;
  /// Present when the agent stopped to ask for credentials; the auth modal needs its details.
  authRequired: AuthRequiredEntry | null;
  sessionKey: number | null;
  /// What the task left behind, which decides whether the archive prompt can offer to remove it.
  taskWorktree: WorktreeWithStatus | null;
  projectId: number | null;
  actions: DialogActions;
}

export function TaskCardDialogs({
  task,
  dialog,
  onClose,
  authRequired,
  sessionKey,
  taskWorktree,
  projectId,
  actions,
}: TaskCardDialogsProps) {
  return (
    <>
      {authRequired && (
        <AgentAuthModal
          agentId={authRequired.agentId}
          agentName={authRequired.agentId}
          connection={authRequired.connection}
          open={dialog === "auth"}
          taskId={task.id}
          sessionKey={sessionKey}
          terminalState={authRequired.terminalState}
          onAuthSuccess={actions.onAuthSuccess}
          onClose={onClose}
          onRetry={actions.onAuthRetry}
        />
      )}

      <AlertDialog open={dialog === "archive"} onOpenChange={(open) => !open && onClose()}>
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
          {/* Three actions with labels this long overflow the row layout at max-w-lg — the buttons
              are nowrap and shrink-0, so they spill past the card edge rather than wrap. This one
              dialog keeps the stacked footer at every width. */}
          <AlertDialogFooter className="sm:flex-col-reverse">
            <AlertDialogCancel>Keep on the board</AlertDialogCancel>
            {taskWorktree &&
              projectId !== null && (
                // Deletes the checkout, not the branch. The commits are the unmerged work this
                // dialog exists to protect; the working copy of them is just disk.
                <AlertDialogAction
                  variant="outline"
                  onClick={() => {
                    onClose();
                    actions.onArchiveAndRemoveWorktree(taskWorktree);
                  }}
                >
                  Archive and remove the worktree
                </AlertDialogAction>
              )}
            <AlertDialogAction
              onClick={() => {
                onClose();
                actions.onArchive();
              }}
            >
              Archive, keep everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "abandon"} onOpenChange={(open) => !open && onClose()}>
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
                over a task it has already abandoned. Same for the dialogs above and below. */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                onClose();
                actions.onAbandon();
              }}
            >
              Abandon
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "emptyReview"} onOpenChange={(open) => !open && onClose()}>
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
                onClose();
                actions.onForceReview();
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
