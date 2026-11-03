import type { LoopCheck, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { cn } from "@/lib/utils";
import type { CurrentState } from "./loop-state";
import { DoneHead, HeadIteration, type HeadActions } from "./HeadIteration";
import { IterationRow } from "./IterationRow";
import { INDENT, RAIL } from "./IterationParts";

/**
 * The loop's iterations as a timeline, newest first. The one running heads it, its Build clock a
 * ring on the rail; the earlier ones hang off the same rail.
 */
export function LoopIterations({
  task,
  iterations,
  checks,
  comments,
  current,
  digest,
  notes,
  actions,
}: {
  task: Task;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
  current: CurrentState | null;
  /** The judge's review digest, shown at sign-off and while the pull request is open. */
  digest?: string;
  /** The agent's notes, shown in the head iteration's Build step. */
  notes?: string | null;
  actions: HeadActions;
}) {
  // An interrupted attempt runs again under the same number, so only the attempt that ran on shows.
  const earlier = [...iterations]
    .reverse()
    .filter((i) => i !== current?.iteration && i.outcome !== "Interrupted");
  const done = !current && task.status === "Done";
  const headed = !!current || done;
  if (!headed && earlier.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-foreground/10 p-4 text-center text-xs text-muted-foreground">
        No iterations yet
      </p>
    );
  }
  return (
    // Inset so the ring's glow is not clipped by the scrolling tab, which has no padding.
    <ul className="pl-1.5">
      {current && (
        <HeadIteration
          task={task}
          current={current}
          iterations={iterations}
          checks={checks}
          comments={comments}
          digest={digest}
          notes={notes}
          actions={actions}
          railBelow={earlier.length > 0}
        />
      )}
      {done && <DoneHead task={task} railBelow={earlier.length > 0} />}
      {earlier.length > 0 && (
        <li className={cn("relative pb-1 pt-1", INDENT)}>
          {headed && <span className={cn("absolute inset-y-0 w-0.5 bg-border", RAIL)} />}
          <span className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {headed ? "Earlier iterations" : "Iterations"}
          </span>
        </li>
      )}
      {earlier.map((iteration, i) => (
        <IterationRow
          key={`${iteration.n}-${iteration.attempt}`}
          task={task}
          iteration={iteration}
          checks={checks}
          first={!headed && i === 0}
          last={i === earlier.length - 1}
        />
      ))}
    </ul>
  );
}
