import { useState } from "react";
import type { Task } from "@/types/bindings";
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
import { ChoiceCards } from "@/components/common/ChoiceCards";
import { usePauseLoopMutation, useStopLoopMutation } from "@/services/loop.service";

type Halt = { value: "after" | "now"; label: string; hint: string };

/**
 * The ways a loop can be halted from where it is, or none. A pause waits for the running step to
 * end; a stop cuts a build or a judge, but cannot cut the checks, so it is not offered there. A
 * loop between steps halts at once either way.
 */
export function haltOptions(task: Task): Halt[] {
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const waiting = task.phase_status === "Waiting" && task.ball === "Agent";
  if (waiting) {
    return [{ value: "now", label: "Now", hint: "Nothing is running, so the loop halts at once." }];
  }
  if (!live) return [];
  const options: Halt[] = [];
  if (!task.loop_summary?.hold) {
    const after = {
      Iterating:
        "The agent finishes its build and the checks run, then the loop pauses. The iteration counts.",
      Checking: "The checks finish, then the loop pauses. Checks cannot be cut off.",
      Judging:
        "The judge finishes, then the loop pauses. If the judge passes the loop, it goes to sign-off instead.",
    }[task.phase as string];
    if (after) options.push({ value: "after", label: "After this step", hint: after });
  }
  const now = {
    Iterating:
      "The agent's session closes. Its work so far is kept as a WIP commit, and the iteration does not count.",
    Judging: "The judge's session closes without a verdict.",
  }[task.phase as string];
  if (now) options.push({ value: "now", label: "Now", hint: now });
  return options;
}

/** Asks whether to halt a loop once its running step ends, or to interrupt that step. */
export function HaltLoopDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const options = haltOptions(task);
  const [picked, setPicked] = useState<Halt["value"]>("after");
  const pause = usePauseLoopMutation();
  const stop = useStopLoopMutation();
  const choice = options.find((o) => o.value === picked) ?? options[0];

  return (
    <AlertDialog open={open && !!choice} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Halt TASK-{task.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing runs until you resume it. The worktree, the iterations and the checks stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ChoiceCards options={options} value={choice?.value} onChange={setPicked} />
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              const key = { projectId: task.project_id, taskId: task.id };
              if (choice?.value === "now") stop.mutate(key);
              else pause.mutate(key);
            }}
          >
            Halt
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
