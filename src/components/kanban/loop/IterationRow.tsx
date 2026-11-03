import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LoopCheck, LoopIteration, Task } from "@/types/bindings";
import { cn } from "@/lib/utils";
import { formatTimeOfDay, formatTokens } from "@/lib/format-utils";
import { Reveal } from "@/components/common/Reveal";
import {
  checkOutcomes,
  failedStep,
  formatDuration,
  lasted,
  plainFirstLine,
  sideNote,
} from "./loop-state";
import { ChecksPanel } from "./CheckCards";
import { AgentSummary, Changed, INDENT, RAIL } from "./IterationParts";

const DOT: Record<string, string> = {
  Pass: "bg-success",
  Fail: "bg-destructive",
  Flaky: "bg-warning",
  Pending: "bg-muted-foreground/25",
  none: "bg-muted-foreground/25",
};

/** An iteration's checks, failed first and open, beside the outcome its agent wrote. */
function IterationDetail({
  task,
  iteration,
  checks,
}: {
  task: Task;
  iteration: LoopIteration;
  checks: LoopCheck[];
}) {
  const outcomes = checkOutcomes(iteration, checks);
  const ran = iteration.results.length > 0;
  const note = sideNote(iteration);
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="min-w-0 space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Checks after it
        </div>
        {ran ? (
          <ChecksPanel iteration={iteration} checks={checks} outcomes={outcomes} />
        ) : (
          <div className="rounded-md border border-dashed border-foreground/10 p-3 text-xs text-muted-foreground">
            {note ? `No checks ran: ${note}.` : "No results recorded for this iteration."}
            {iteration.outcome === "Failed" && iteration.check_output && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
                {iteration.check_output.trim()}
              </pre>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Outcome
        </div>
        <AgentSummary task={task} iteration={iteration} />
      </div>
    </div>
  );
}

/** An earlier iteration on the rail: two lines closed, its checks and its outcome open. */
export function IterationRow({
  task,
  iteration,
  checks,
  first,
  last,
}: {
  task: Task;
  iteration: LoopIteration;
  checks: LoopCheck[];
  /** The rail starts at its node: nothing is above it. */
  first: boolean;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const outcomes = checkOutcomes(iteration, checks);
  const ran = iteration.results.length > 0;
  const stepFailed = failedStep(iteration, checks);
  const firstLine = iteration.blocked
    ? `Blocked: ${plainFirstLine(iteration.blocked)}`
    : plainFirstLine(iteration.summary);
  const toggle = () => setOpen(!open);
  const note = sideNote(iteration);
  return (
    <li className={cn("relative pb-1", INDENT)}>
      {!(first && last) && (
        <span
          className={cn(
            "absolute w-0.5 bg-border",
            RAIL,
            first ? "top-5" : "top-0",
            last ? "h-5" : "bottom-0",
          )}
        />
      )}
      <span className="absolute left-[30px] top-3.5 size-3 rounded-full border-2 border-foreground/10 bg-background" />
      <div className={cn("rounded-lg", open && "glass-tile")}>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-foreground/7"
          onClick={toggle}
        >
          <ChevronRight
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          <span className="w-8 shrink-0 text-base font-semibold leading-6">#{iteration.n}</span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="shrink-0 tabular-nums">
                {formatTimeOfDay(iteration.started_at)}
                {iteration.ended_at && ` · ${formatDuration(lasted(iteration))}`}
              </span>
              {iteration.tokens != null && (
                <span className="shrink-0 tabular-nums">
                  {formatTokens(iteration.tokens)} tokens
                </span>
              )}
              {iteration.outcome !== "Interrupted" && (
                <span className="shrink-0">
                  <Changed iteration={iteration} />
                </span>
              )}
              <span className="flex-1" />
              {stepFailed ? (
                <span className="shrink-0 text-destructive">
                  Checks did not run: step {stepFailed.n} failed
                </span>
              ) : ran ? (
                <span className="flex shrink-0 items-center gap-1">
                  {outcomes.map(({ check, result }) => (
                    <span
                      key={check.id}
                      title={`${check.label}: ${result ? result.state.toLowerCase() : "not run"}`}
                      className={cn("size-2.5 rounded-full", DOT[result?.state ?? "none"])}
                    />
                  ))}
                </span>
              ) : (
                note && (
                  <span
                    className={cn(
                      "shrink-0",
                      iteration.outcome === "Failed" && "text-destructive",
                      iteration.outcome === "Blocked" && "text-warning",
                    )}
                  >
                    {note}
                  </span>
                )
              )}
            </span>
            {!open && firstLine && (
              <span className="block truncate text-xs leading-relaxed text-foreground">
                {firstLine}
              </span>
            )}
          </span>
        </button>
        <Reveal open={open}>
          <div className="px-3 pb-3 pl-[68px]">
            <IterationDetail task={task} iteration={iteration} checks={checks} />
          </div>
        </Reveal>
      </div>
    </li>
  );
}
