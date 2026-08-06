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
import type { Task } from "@/types/bindings";

/**
 * The refiner's gate: the description as it stands, and what the refiner suggests instead.
 *
 * Shown as a comparison rather than as an edit already applied, because that is the whole reason
 * the refiner writes nothing itself. Accepting is the first moment the task changes, which makes
 * rejecting safe by construction rather than dependent on a snapshot having been taken correctly.
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

  // The proposal is the refiner's closing message, which lives in the outcome thread rather than
  // on the task. Only asked for while the dialog is open, so a board full of cards is not each
  // fetching a thread nobody is looking at.
  const { data: comments } = useTaskCommentsQuery(open ? task.id : undefined);

  const proposal = [...(comments ?? [])].reverse().find((c) => c.kind === "proposal");

  const settle = (accept: boolean) => {
    closeRefinement.mutate({ taskId: task.id, accept }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent" />
            Proposed description
          </DialogTitle>
          <DialogDescription>
            Nothing has changed yet. Accepting replaces the description with the text on the right;
            either way the proposal stays in the task's thread.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 min-h-0">
          <section className="min-w-0">
            <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">Now</h4>
            <pre className="text-xs whitespace-pre-wrap break-words bg-muted rounded-md p-3 max-h-96 overflow-auto">
              {task.description?.trim() || "No description"}
            </pre>
          </section>
          <section className="min-w-0">
            <h4 className="text-xs font-semibold text-accent mb-1.5">Proposed</h4>
            <pre className="text-xs whitespace-pre-wrap break-words bg-muted rounded-md p-3 max-h-96 overflow-auto">
              {/* The refiner ending its turn is what opens this gate, so an empty proposal means
                  it finished with nothing to say — worth showing plainly rather than as a blank
                  panel the user has to interpret. */}
              {proposal?.body?.trim() || "The refiner ended its turn without proposing anything."}
            </pre>
          </section>
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
            disabled={closeRefinement.isPending || !proposal?.body?.trim()}
          >
            Use this description
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
