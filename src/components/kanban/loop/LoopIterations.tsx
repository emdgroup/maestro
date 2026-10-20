import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Dice5,
  Gavel,
  Hammer,
  Minus,
  OctagonX,
  Pause,
  Play,
  StickyNote,
  Terminal,
  X,
} from "lucide-react";
import type { LoopCheck, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { formatTokens } from "@/views/usage/format";
import type { SessionActivityStatus } from "@/store/sessionActivityStore";
import {
  checkOutcomes,
  failedFirst,
  failingBefore,
  formatDuration,
  lastLine,
  notesGiven,
  type CheckOutcome,
} from "./loop-state";

/** The rail runs down the middle of the 72px ring, and the cards start past it. */
const RAIL = "left-[35px]";
const INDENT = "pl-[88px]";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const secsBetween = (from: string, to: number) => Math.max(0, (to - Date.parse(from)) / 1000);

/** What the Build's agent is doing, in the words its session gives. */
const DOING: Record<SessionActivityStatus, string> = {
  spawning: "Starting",
  thinking: "Thinking",
  acting: "Using tools",
  awaiting_input: "Waiting for your answer",
  idle: "Working",
  stale: "Working",
};

/** Which of Build, Checks and Judge the current iteration is in. */
type Step = 0 | 1 | 2;

/** Where the current iteration stands, as the tab draws it. */
export interface CurrentState {
  iteration: LoopIteration;
  step: Step;
  /** Stopped through `loop_blocked`, its question waiting for an answer. */
  blocked: boolean;
  /** The Build's session, while there is one. */
  activity: { status: SessionActivityStatus; since: number } | null;
}

/**
 * The Build clock as a ring, the current iteration's node on the timeline. While it builds, the
 * time used against `max_build_secs`; once the Build is done, full, with the iteration's time so
 * far. Its own component so only it ticks.
 */
function ClockRing({
  current,
  limitSecs,
  amber,
}: {
  current: CurrentState;
  limitSecs: number;
  amber: boolean;
}) {
  const now = useNow(30_000);
  const { iteration, step, blocked } = current;
  const ended = iteration.ended_at ? Date.parse(iteration.ended_at) : now;
  const used = secsBetween(iteration.started_at, blocked ? ended : now);
  const building = step === 0;
  const share = building ? Math.min(1, used / limitSecs) : 1;
  const late = building && !blocked && limitSecs - used <= 10 * 60;
  const tone = amber
    ? "text-warning"
    : !building
      ? "text-success"
      : late
        ? "text-destructive"
        : "text-accent";
  const r = 34;
  const length = 2 * Math.PI * r;
  return (
    <div
      role="progressbar"
      aria-label={
        building ? `Build: ${formatDuration(used)} of ${formatDuration(limitSecs)}` : "Build done"
      }
      aria-valuemin={0}
      aria-valuemax={limitSecs}
      aria-valuenow={Math.min(used, limitSecs)}
      className={cn(
        "relative grid size-[72px] shrink-0 place-items-center rounded-full bg-card",
        !blocked && (amber ? "animate-glow-warning" : "animate-glow-accent"),
      )}
    >
      <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80" aria-hidden>
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - share)}
          className={cn("transition-[stroke-dashoffset] duration-700", tone)}
        />
      </svg>
      <div className="text-center leading-none">
        <div className="text-sm font-bold tabular-nums">{formatDuration(used)}</div>
        <div className="mt-0.5 text-[9px] text-muted-foreground">
          {blocked ? "stopped" : building ? `of ${formatDuration(limitSecs)}` : "so far"}
        </div>
      </div>
    </div>
  );
}

/** How long the agent has been at what it is doing; nothing under a minute. */
function Since({ since }: { since: number }) {
  const now = useNow(30_000);
  const secs = (now - since) / 1000;
  return secs < 60 ? null : <span>for {formatDuration(secs)}</span>;
}

function StepTile({
  label,
  icon: Icon,
  sub,
  state,
  optional,
}: {
  label: string;
  icon: typeof Check;
  sub: React.ReactNode;
  state: "done" | "live" | "waiting" | "todo";
  /** Runs only when the steps before it pass. */
  optional?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5",
        state === "done" && "border-success/40 bg-success/5",
        state === "live" && "border-accent/50 bg-accent/10",
        state === "waiting" && "border-warning/60 bg-warning/10",
        state === "todo" && (optional ? "border-dashed border-border" : "border-border"),
      )}
    >
      {state === "done" ? (
        <Check className="size-4 shrink-0 text-success" />
      ) : (
        <Icon
          className={cn(
            "size-4 shrink-0",
            state === "live" && "text-accent",
            state === "waiting" && "text-warning",
            state === "todo" && "text-muted-foreground",
          )}
        />
      )}
      <div className="min-w-0">
        <div
          className={cn(
            "text-sm",
            (state === "live" || state === "waiting") && "font-semibold",
            state === "todo" && "text-muted-foreground",
          )}
        >
          {label}
        </div>
        <div className="truncate text-[11px] tabular-nums text-muted-foreground">{sub}</div>
      </div>
      {state === "live" && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
          <div className="absolute inset-y-0 left-0 w-[60%] animate-rail-comet bg-gradient-to-r from-transparent via-accent/50 to-accent" />
        </div>
      )}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const changed = (iteration: LoopIteration) => (
  <span className="tabular-nums">
    {plural(iteration.files, "file")} <span className="text-success">+{iteration.added}</span>{" "}
    <span className="text-destructive">−{iteration.removed}</span>
  </span>
);

/** The head of the timeline: the clock ring on the rail, and beside it the iteration's card. */
function CurrentIteration({
  task,
  current,
  iterations,
  checks,
  comments,
  onJoin,
  onResume,
  railBelow,
}: {
  task: Task;
  current: CurrentState;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
  onJoin: (() => void) | null;
  onResume: (answer: string) => void;
  /** Earlier iterations follow, so the rail runs on down to them. */
  railBelow: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const { iteration, step, blocked, activity } = current;
  const config = task.loop_config;
  const hold = task.loop_summary?.hold;
  const asking = step === 0 && activity?.status === "awaiting_input";
  const amber = blocked || asking;
  const real = checks.filter((c) => !c.proposed || c.accepted);
  const commands = real.filter((c) => c.kind === "Command").length;
  const judged = real.some((c) => c.kind === "Judge");
  const doing = activity ? DOING[activity.status] : "Working";

  const word = blocked ? "Blocked" : step === 1 ? "Running checks" : step === 2 ? "Judging" : doing;
  const run = config?.setup_command
    ? `Run first, then ${plural(commands, "command")}`
    : plural(commands, "command");
  const buildSub = blocked ? (
    `stopped after ${formatDuration(secsBetween(iteration.started_at, Date.parse(iteration.ended_at ?? iteration.started_at)))}`
  ) : step > 0 ? (
    "done"
  ) : (
    <>
      {doing} {activity && <Since since={activity.since} />}
    </>
  );
  const failing = failingBefore(iterations, iteration, checks);
  const notes = notesGiven(comments, iterations, iteration);

  return (
    <li className={cn("relative pb-4", INDENT)}>
      {railBelow && (
        <span
          className={cn(
            "absolute bottom-0 top-[80px] w-0.5 bg-gradient-to-b to-border",
            RAIL,
            amber ? "from-warning" : "from-accent",
          )}
        />
      )}
      <span className="absolute left-0 top-2">
        <ClockRing current={current} limitSecs={config?.max_build_secs ?? 7200} amber={amber} />
      </span>
      <span
        className={cn(
          "absolute left-[72px] top-[43px] h-0.5 w-4",
          amber ? "bg-warning/50" : "bg-accent/40",
        )}
      />
      <section
        className={cn(
          "space-y-3 rounded-xl border bg-card p-4",
          amber ? "border-warning/50" : "border-accent/30",
        )}
      >
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tabular-nums">#{iteration.n}</span>
          <span className="text-xs text-muted-foreground">
            of {config?.max_iterations ?? "?"} · started {time(iteration.started_at)}
          </span>
          <span
            className={cn(
              "ml-1 flex items-center gap-2 text-sm font-medium",
              amber && "text-warning",
            )}
          >
            <span
              className={cn(
                "size-2.5 rounded-full",
                amber ? "bg-warning" : "animate-pulse bg-accent",
              )}
            />
            {word}
          </span>
          <div className="flex-1" />
          {hold && !blocked && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {hold === "Stopped" ? <OctagonX className="size-3" /> : <Pause className="size-3" />}
              {hold === "Stopped" ? "Stops" : "Pauses"} once this iteration ends
            </span>
          )}
          {iteration.tokens != null && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTokens(iteration.tokens)} tokens
            </span>
          )}
          {onJoin && !blocked && (
            <Button
              size="sm"
              variant="outline"
              className={cn(asking && "border-warning/60 text-warning")}
              onClick={onJoin}
            >
              <CornerDownRight className="size-3" />
              {asking ? "Join to answer" : "Join"}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <StepTile
            label="Build"
            icon={Hammer}
            sub={buildSub}
            state={step > 0 ? "done" : amber ? "waiting" : "live"}
          />
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
          <StepTile
            label="Checks"
            icon={Terminal}
            sub={step > 1 ? `${commands} of ${commands} commands pass` : run}
            state={step === 1 ? "live" : step > 1 ? "done" : "todo"}
          />
          {judged && (
            <>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
              <StepTile
                label="Judge"
                icon={Gavel}
                sub={step === 2 ? "reading the changes" : "if every command passes"}
                state={step === 2 ? "live" : "todo"}
                optional
              />
            </>
          )}
        </div>

        {blocked ? (
          <>
            <div className="rounded-md border border-warning/40 bg-background p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
              <MarkdownBlock text={iteration.blocked ?? ""} projectId={task.project_id} />
            </div>
            <Textarea
              value={answer}
              rows={4}
              placeholder={`Your answer, in markdown. Iteration ${iteration.n + 1} gets it with the question.`}
              onChange={(e) => setAnswer(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Its work ({changed(iteration)}) is committed and the checks did not run.
              </span>
              <div className="flex-1" />
              <Button
                size="sm"
                disabled={!answer.trim()}
                onClick={() => {
                  onResume(answer.trim());
                  setAnswer("");
                }}
              >
                <Play className="size-3" />
                Resume with this answer
              </Button>
            </div>
          </>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Working on
            </span>
            {failing.length === 0 && notes.length === 0 && (
              <span className="text-xs text-muted-foreground">
                The task and its checks{iteration.n === 1 ? ", for the first time" : ""}.
              </span>
            )}
            {failing.map((f) => (
              <span
                key={f.label}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs"
              >
                <X className="size-3 shrink-0 text-destructive" />
                <span className="truncate font-medium">{f.label}</span>
                {f.line && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {f.line}
                  </span>
                )}
              </span>
            ))}
            {notes.map((note) => (
              <span
                key={note.id}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-accent/5 px-2 py-1 text-xs"
              >
                <StickyNote className="size-3 shrink-0 text-accent" />
                <span className="truncate">{note.body}</span>
              </span>
            ))}
          </div>
        )}
      </section>
    </li>
  );
}

const DOT: Record<string, string> = {
  Pass: "bg-success",
  Fail: "bg-destructive",
  Flaky: "bg-warning",
  Pending: "bg-muted-foreground/25",
  none: "bg-muted-foreground/25",
};

const MARK = {
  Pass: { icon: Check, tone: "text-success" },
  Fail: { icon: X, tone: "text-destructive" },
  Flaky: { icon: Dice5, tone: "text-warning" },
  Pending: { icon: Minus, tone: "text-muted-foreground/60" },
};

/** Compact, one under the other, each opening on its own output. */
function CheckCards({
  outcomes,
  open,
  onToggle,
}: {
  outcomes: CheckOutcome[];
  open: Set<number>;
  onToggle: (checkId: number) => void;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
      {failedFirst(outcomes).map(({ check, result }) => {
        const { icon: Mark, tone } = MARK[result?.state ?? "Pending"];
        const opened = open.has(check.id);
        const tail = result
          ? lastLine(result.detail)
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
                className="block w-full hover:bg-muted/50"
                onClick={() => onToggle(check.id)}
              >
                {head}
              </button>
            ) : (
              head
            )}
            {result && opened && (
              <div className="border-t border-border bg-background">
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

/** A markdown text's first line with something on it, its heading or list marks dropped. */
const plainFirstLine = (text: string | null | undefined) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean) ?? "";

/** What a row says where its dots would be, for an iteration whose checks did not run. */
function sideNote(iteration: LoopIteration): string | null {
  switch (iteration.outcome) {
    case "Interrupted":
      return "cut off, not counted";
    case "Empty":
      return "changed nothing";
    case "Failed":
      return "the agent failed";
    case "Blocked":
      return "blocked, checks not run";
    default:
      return null;
  }
}

/** An earlier iteration on the rail: two lines closed, its checks and its outcome open. */
function IterationRow({
  task,
  iteration,
  checks,
  last,
}: {
  task: Task;
  iteration: LoopIteration;
  checks: LoopCheck[];
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openChecks, setOpenChecks] = useState<Set<number>>(new Set());
  const outcomes = checkOutcomes(iteration, checks);
  const ran = iteration.results.length > 0;
  const firstLine = iteration.blocked
    ? `Blocked: ${plainFirstLine(iteration.blocked)}`
    : plainFirstLine(iteration.summary);
  const toggle = () => {
    if (!open) {
      const failed = failedFirst(outcomes).find((o) => o.result && o.result.state !== "Pass");
      setOpenChecks(new Set(failed ? [failed.check.id] : []));
    }
    setOpen(!open);
  };
  const note = sideNote(iteration);
  return (
    <li className={cn("relative pb-1", INDENT)}>
      <span className={cn("absolute top-0 w-0.5 bg-border", RAIL, last ? "h-5" : "bottom-0")} />
      <span className="absolute left-[30px] top-3.5 size-3 rounded-full border-2 border-border bg-background" />
      <div className={cn("rounded-lg", open && "border border-border bg-card")}>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted/30"
          onClick={toggle}
        >
          {open ? (
            <ChevronDown className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="w-8 shrink-0 text-base font-semibold leading-6">#{iteration.n}</span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="shrink-0 tabular-nums">
                {time(iteration.started_at)}
                {iteration.ended_at &&
                  ` · ${formatDuration(secsBetween(iteration.started_at, Date.parse(iteration.ended_at)))}`}
              </span>
              {iteration.attempt > 1 && (
                <span className="shrink-0">attempt {iteration.attempt}</span>
              )}
              {iteration.agent_id && <span className="shrink-0">{iteration.agent_id}</span>}
              {iteration.tokens != null && (
                <span className="shrink-0 tabular-nums">
                  {formatTokens(iteration.tokens)} tokens
                </span>
              )}
              {iteration.outcome !== "Interrupted" && (
                <span className="shrink-0">{changed(iteration)}</span>
              )}
              <span className="flex-1" />
              {ran ? (
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
        {open && (
          <div className="grid grid-cols-2 gap-4 px-3 pb-3 pl-[68px]">
            <div className="min-w-0 space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Checks after it
              </div>
              {ran ? (
                <CheckCards
                  outcomes={outcomes}
                  open={openChecks}
                  onToggle={(id) => {
                    const next = new Set(openChecks);
                    if (!next.delete(id)) next.add(id);
                    setOpenChecks(next);
                  }}
                />
              ) : (
                <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  {note ? `No checks ran: ${note}.` : "No results recorded for this iteration."}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Outcome
              </div>
              <div className="rounded-md border border-border bg-background p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
                {iteration.summary || iteration.blocked ? (
                  <MarkdownBlock
                    text={iteration.summary ?? iteration.blocked ?? ""}
                    projectId={task.project_id}
                  />
                ) : (
                  <span className="text-muted-foreground">The agent wrote no summary.</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

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
  onJoin,
  onResume,
}: {
  task: Task;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
  current: CurrentState | null;
  onJoin: (() => void) | null;
  onResume: (answer: string) => void;
}) {
  const earlier = [...iterations].reverse().filter((i) => i !== current?.iteration);
  if (!current && earlier.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        No iterations yet
      </p>
    );
  }
  return (
    <ul>
      {current && (
        <CurrentIteration
          task={task}
          current={current}
          iterations={iterations}
          checks={checks}
          comments={comments}
          onJoin={onJoin}
          onResume={onResume}
          railBelow={earlier.length > 0}
        />
      )}
      {earlier.length > 0 && (
        <li className={cn("relative pb-1 pt-1", INDENT)}>
          {current && <span className={cn("absolute inset-y-0 w-0.5 bg-border", RAIL)} />}
          <span className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {current ? "Earlier iterations" : "Iterations"}
          </span>
        </li>
      )}
      {earlier.map((iteration, i) => (
        <IterationRow
          key={`${iteration.n}-${iteration.attempt}`}
          task={task}
          iteration={iteration}
          checks={checks}
          last={i === earlier.length - 1}
        />
      ))}
    </ul>
  );
}
