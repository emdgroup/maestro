import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Dice5, Minus, X } from "lucide-react";
import type { LoopCheck, LoopIteration, Task } from "@/types/bindings";
import { cn } from "@/lib/utils";
import { MarkdownBlock } from "@/components/common/markdown/MarkdownBlock";
import { failedFirst, failedStep, lastLine, setupOutcomes, type CheckOutcome } from "./loop-state";

export const MARK = {
  Pass: { icon: Check, tone: "text-success" },
  Fail: { icon: X, tone: "text-destructive" },
  Flaky: { icon: Dice5, tone: "text-warning" },
  Pending: { icon: Minus, tone: "text-muted-foreground/60" },
};

/** Compact, one under the other, each opening on its own output. */
export function CheckCards({
  outcomes,
  open,
  onToggle,
  running = false,
  inOrder = false,
}: {
  outcomes: CheckOutcome[];
  open: Set<number>;
  onToggle: (checkId: number) => void;
  /** They are running now, in order: the first without a result is the one running. */
  running?: boolean;
  /** Kept in the order they run, as steps are, rather than failed first. */
  inOrder?: boolean;
}) {
  const runningId = running ? outcomes.find((o) => !o.result)?.check.id : undefined;
  return (
    <ul className="divide-y divide-foreground/7 overflow-hidden rounded-lg border border-foreground/7 bg-background/50">
      {(inOrder ? outcomes : failedFirst(outcomes)).map(({ check, result }) => {
        const { icon: Mark, tone } = MARK[result?.state ?? "Pending"];
        const opened = open.has(check.id);
        const tail = result
          ? lastLine(result.detail)
          : running
            ? check.id === runningId
              ? "running"
              : "waiting"
            : check.kind === "Judge"
              ? "runs once every command passes"
              : check.kind === "Manual"
                ? "ticked at sign-off"
                : "did not run";
        const head = (
          <span className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs">
            {result ? (
              opened ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="size-3 shrink-0" />
            )}
            <Mark className={cn("size-3.5 shrink-0", tone)} />
            <span className={cn("shrink-0", result ? "font-medium" : "text-muted-foreground")}>
              {check.label}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">{tail}</span>
          </span>
        );
        return (
          <li
            key={check.id}
            className={cn(
              result?.state === "Fail" && "bg-destructive/5",
              result?.state === "Flaky" && "bg-warning/5",
            )}
          >
            {result ? (
              <button
                type="button"
                aria-expanded={opened}
                className="block w-full hover:bg-foreground/7"
                onClick={() => onToggle(check.id)}
              >
                {head}
              </button>
            ) : (
              head
            )}
            {result && opened && (
              <div className="border-t border-foreground/7">
                {result.command && (
                  <div className="px-3 pt-1.5 font-mono text-[11px] text-muted-foreground">
                    $ {result.command}
                  </div>
                )}
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2 pt-1 font-mono text-[11px] leading-relaxed">
                  {result.detail?.trim() || "No output."}
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The steps before the checks, then the checks, as one round ran them. */
export function ChecksPanel({
  iteration,
  checks,
  outcomes,
  running = false,
}: {
  iteration: LoopIteration;
  checks: LoopCheck[];
  /** The checks to show after the steps. */
  outcomes: CheckOutcome[];
  running?: boolean;
}) {
  const steps = setupOutcomes(iteration, checks);
  if (steps.length === 0) return <CheckList outcomes={outcomes} running={running} />;
  const failed = failedStep(iteration, checks);
  const stepping = running && steps.some((o) => !o.result);
  const heading = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
  return (
    <div className="space-y-1.5">
      <div className={heading}>Setup checks environment</div>
      <CheckList outcomes={steps} running={stepping} inOrder />
      <div className={cn(heading, "pt-1")}>Checks</div>
      {failed ? (
        <p className="text-xs text-destructive">Checks did not run: step {failed.n} failed.</p>
      ) : (
        <CheckList outcomes={outcomes} running={running && !stepping} />
      )}
    </div>
  );
}

/** Check cards that open on their own on the first one that did not pass. */
function CheckList({
  outcomes,
  running,
  inOrder,
}: {
  outcomes: CheckOutcome[];
  running?: boolean;
  inOrder?: boolean;
}) {
  const [open, setOpen] = useState<Set<number>>(() => {
    const failed = failedFirst(outcomes).find((o) => o.result && o.result.state !== "Pass");
    return new Set(failed ? [failed.check.id] : []);
  });
  return (
    <CheckCards
      outcomes={outcomes}
      open={open}
      running={running}
      inOrder={inOrder}
      onToggle={(id) => {
        const next = new Set(open);
        if (!next.delete(id)) next.add(id);
        setOpen(next);
      }}
    />
  );
}

/** The judge's checks: each criterion, its verdict, and the judge's reasons in prose. */
export function JudgeVerdicts({
  task,
  outcomes,
  running,
}: {
  task: Task;
  outcomes: CheckOutcome[];
  running: boolean;
}) {
  return (
    <ul className="space-y-2">
      {outcomes.map(({ check, result }) => {
        const { icon: Mark, tone } = MARK[result?.state ?? "Pending"];
        const failed = result?.state === "Fail";
        return (
          <li
            key={check.id}
            className={cn(
              "space-y-2 rounded-lg border p-3 text-xs",
              failed
                ? "border-destructive/40 bg-destructive/5"
                : "border-foreground/7 bg-background/50",
            )}
          >
            <div className="flex items-start gap-2 font-medium">
              <Mark className={cn("mt-px size-3.5 shrink-0", tone)} />
              <span className="flex-1">{check.label}</span>
              <span className={cn("shrink-0", tone)}>
                {!result
                  ? running
                    ? "judging"
                    : "not reached"
                  : result.state === "Pass"
                    ? "passed"
                    : result.state === "Fail"
                      ? "failed"
                      : result.state.toLowerCase()}
              </span>
            </div>
            {result?.detail?.trim() && (
              <div className="pl-5.5 leading-relaxed text-muted-foreground">
                <MarkdownBlock text={result.detail} projectId={task.project_id} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
