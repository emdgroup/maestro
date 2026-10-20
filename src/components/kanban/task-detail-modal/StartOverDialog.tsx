import { useState } from "react";
import type { Task, TaskStatus } from "@/types/bindings";
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
import { useRestartTaskMutation } from "@/services/task.service";

/** Whether starting over gives the task a new branch from the base, rather than rewinding its own. */
export const startsFresh = (task: Task) => task.status === "Done" || task.status === "Cancelled";

/**
 * What the footer offers once the task has left the columns it is edited in. A task an agent is
 * working in can be stopped; one nothing is working in can be started over. A hand-off waiting for
 * a slot is neither: the loop's Stop covers it, and a pipeline task's next stage starts on its own.
 */
export function runControls(task: Task) {
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const busy = live || task.phase === "Spawning" || task.phase === "Checking";
  const handingOff = task.phase_status === "Waiting" && task.ball === "Agent";
  const hasRun =
    (task.status !== "Planning" && task.status !== "Queue") ||
    (task.run_mode === "Loop" && (task.loop_summary?.iteration ?? 0) > 0);
  return { live, startOver: hasRun && !busy && !handingOff };
}

const LANDINGS: { value: TaskStatus; label: string; hint: string }[] = [
  { value: "Planning", label: "Planning", hint: "Edit it first, then drag it to Queue." },
  { value: "Queue", label: "Queue", hint: "Runs again as soon as a slot is free." },
];

/** Asks before throwing a task's work away, and where it lands. */
export function StartOverDialog({
  task,
  branch,
  open,
  onOpenChange,
}: {
  task: Task;
  /** The task's branch, when it has one. */
  branch: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [landing, setLanding] = useState<TaskStatus>("Planning");
  const restart = useRestartTaskMutation();
  const fresh = startsFresh(task);
  const isLoop = task.run_mode === "Loop";
  const kept = isLoop
    ? "The description, labels, profiles, checks, hidden files and limits stay."
    : "The description, labels and profiles stay.";
  const named = (fallback: string) => (branch ? `The branch ${branch}` : fallback);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start TASK-{task.id} over?</AlertDialogTitle>
          <AlertDialogDescription>
            {fresh
              ? `It starts on a new branch from ${task.base_branch || "the base"}. ${named(
                  "Its old branch",
                )} and anything already merged from it are left alone. Its stages and review are cleared. ${kept}`
              : `Its progress will be lost. ${named("Its branch")} goes back to where the ${
                  isLoop ? "loop" : "task"
                } started, so the code its agents wrote is gone. Its stages and review${
                  isLoop ? ", iterations and check results" : ""
                } are cleared. ${kept}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ChoiceCards label="Put it in" options={LANDINGS} value={landing} onChange={setLanding} />
        <AlertDialogFooter>
          <AlertDialogCancel>{fresh ? "Keep it as is" : "Keep its progress"}</AlertDialogCancel>
          <AlertDialogAction
            variant={fresh ? "default" : "destructive"}
            onClick={() => {
              onOpenChange(false);
              restart.mutate({ projectId: task.project_id, taskId: task.id, status: landing });
            }}
          >
            Start over
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
