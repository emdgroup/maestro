import { useState } from "react";
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
import { Textarea } from "@/ui/textarea";
import { useTaskCommentsQuery } from "@/services/task.service";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";
import type { Task } from "@/types/bindings";

/**
 * The planner's gate: what it proposes to do, before anything is written.
 *
 * The plan is an artifact on the task, not a message in a session — and by the time this opens the
 * session that produced it is closed. That is not incidental. A project can put a different agent
 * behind `Planner` and `Coder`, so "approve" cannot mean "tell the planner to go ahead": there may
 * be no shared session to say it in, and the agent that would hear it is not the one that will do
 * the work. Approving starts a fresh coder and hands it the plan.
 *
 * Which is also why the plan survives: it can be read days later, against a session that is gone by
 * construction rather than by accident.
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
  /// `feedback` empty means "start over"; with text it means "this plan, but address this".
  onReplan: (feedback: string) => void;
}) {
  const { data: comments } = useTaskCommentsQuery(open ? task.id : undefined);
  const projectId = useSelectedProject()?.id;
  const [feedback, setFeedback] = useState("");

  // A new plan is a new decision, so the notes on the last one do not carry over into it.
  // Adjusted during render rather than from an effect, which would paint one frame of the
  // reopened gate still holding the previous plan's notes.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setFeedback("");
  }

  const plan = [...(comments ?? [])].reverse().find((c) => c.kind === "plan");
  const body = plan?.body?.trim();
  const annotated = feedback.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sized like the task detail modal: a plan is a document, and half-width preformatted
          columns are how the proposal gate got unreadable. */}
      <DialogContent className="sm:w-fit sm:min-w-160 sm:max-w-[90vw] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-4 text-accent" />
            Plan for “{task.title}”
          </DialogTitle>
          <DialogDescription>
            Nothing has been written yet, and the session that wrote this plan has been closed.
            Approving starts a coder with it.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 max-h-[50vh] overflow-y-auto custom-scrollbar rounded-md bg-muted p-4 text-sm">
          {body ? (
            <MarkdownBlock text={body} projectId={projectId} />
          ) : (
            <p className="text-muted-foreground">
              The planner ended its turn without producing a plan.
            </p>
          )}
        </div>

        <Textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Notes on the plan. Leave empty to approve it as it stands"
          className="min-h-20 max-h-40 text-sm"
        />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onReplan("");
            }}
          >
            Plan again
          </Button>
          {/* One button with two meanings, because the notes above decide which one the user is
              asking for. Approving a plan they have just written objections to is not a thing to
              offer; the objections are the answer. */}
          <Button
            className={buttonVariants({ variant: "accent" })}
            onClick={() => {
              onOpenChange(false);
              if (annotated) onReplan(feedback.trim());
              else onApprove();
            }}
            disabled={!body}
          >
            {annotated ? "Refine plan" : "Start implementing"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
