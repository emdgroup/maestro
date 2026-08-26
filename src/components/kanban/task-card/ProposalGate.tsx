import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/ui/dialog";
import { Button, buttonVariants } from "@/ui/button";
import { useCloseRefinementMutation, useTaskCommentsQuery } from "@/services/task.service";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";
import type { Task } from "@/types/bindings";

/**
 * The refiner's gate: what the refiner suggests the description should say.
 *
 * Rendered, and on its own. It was a two-column "Now" against "Proposed", which sounds like the
 * right shape for a decision and is not: both sides are markdown documents, so side by side in
 * half-width preformatted blocks they read as neither prose nor a diff, and the current
 * description is already on the card behind the dialog. What the comparison was protecting —
 * that nothing has been applied yet, so rejecting is safe by construction rather than dependent on
 * a snapshot — is a property of accepting being the first write, and the copy says so.
 */
export function ProposalGate({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const closeRefinement = useCloseRefinementMutation();
  const projectId = useSelectedProject()?.id;

  // The proposal is the refiner's closing message, which lives in the outcome thread rather than
  // on the task. Only asked for while the dialog is open, so a board full of cards is not each
  // fetching a thread nobody is looking at.
  const { data: comments } = useTaskCommentsQuery(open ? task.id : undefined);

  const proposal = [...(comments ?? [])].reverse().find((c) => c.kind === "proposal");
  const body = proposal?.body?.trim();

  const settle = (accept: boolean) => {
    closeRefinement.mutate({ taskId: task.id, accept }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sized like the task detail modal, because it is showing the same thing: a description,
          full width, as markdown. */}
      <DialogContent className="sm:w-fit sm:min-w-160 sm:max-w-[90vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent" />
            Proposed description
          </DialogTitle>
          <DialogDescription>
            Nothing has changed yet. Accepting replaces the task's description with this.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 max-h-[60vh] overflow-y-auto custom-scrollbar rounded-md bg-muted p-4 text-sm">
          {/* The refiner ending its turn is what opens this gate, so an empty proposal means it
              finished with nothing to say — worth showing plainly rather than as a blank panel the
              user has to interpret. */}
          {body ? (
            <MarkdownBlock text={body} projectId={projectId} />
          ) : (
            <p className="text-muted-foreground">
              The refiner ended its turn without proposing anything.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => settle(false)}
            disabled={closeRefinement.isPending}
          >
            Discard
          </Button>
          <Button
            className={buttonVariants({ variant: "accent" })}
            onClick={() => settle(true)}
            disabled={closeRefinement.isPending || !body}
          >
            Use this description
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
