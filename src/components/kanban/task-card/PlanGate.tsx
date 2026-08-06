import { ListChecks } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/ui/dialog";
import { Button, buttonVariants } from "@/ui/button";
import { useTaskCommentsQuery } from "@/services/task.service";
import type { Task } from "@/types/bindings";

/**
 * The planner's gate: what it proposes to do, before anything is written.
 *
 * The plan is the planner's closing message, kept in the task's outcome thread. It is not a file
 * the planner wrote, and it could not be: the planner is held read-only, which is the whole basis
 * of this gate — a user saying "go ahead" inside the session cannot become implementation, because
 * the agent physically cannot write until the board says so.
 *
 * That the plan lives in the thread rather than in the session is what makes the gate survivable:
 * it can be read days later, against a session that has since died.
 */
export function PlanGate({
  task,
  open,
  onOpenChange,
  onApprove,
  onReplan,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: () => void;
  onReplan: () => void;
}) {
  const { data: comments } = useTaskCommentsQuery(open ? task.id : undefined);
  const plan = [...(comments ?? [])].reverse().find((c) => c.kind === "plan");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-4 text-accent" />
            Plan for “{task.title}”
          </DialogTitle>
          <DialogDescription>
            Nothing has been written yet — the planner cannot modify files. Approving starts the
            coder with this plan.
          </DialogDescription>
        </DialogHeader>

        <pre className="text-xs whitespace-pre-wrap break-words bg-muted rounded-md p-3 max-h-[28rem] overflow-auto">
          {plan?.body?.trim() || "The planner ended its turn without producing a plan."}
        </pre>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onReplan();
            }}
          >
            Plan again
          </Button>
          <Button
            className={buttonVariants({ variant: "accent" })}
            onClick={() => {
              onOpenChange(false);
              onApprove();
            }}
            disabled={!plan?.body?.trim()}
          >
            Start implementing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
