import { Fragment, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  CircleCheck,
  ChevronRight,
  CornerDownRight,
  Dice5,
  Gavel,
  GitMerge,
  GitPullRequest,
  Hammer,
  Hourglass,
  Minus,
  NotebookPen,
  OctagonX,
  Pause,
  Pencil,
  Play,
  Repeat,
  StickyNote,
  Terminal,
  User,
  X,
} from "lucide-react";
import type { LoopCheck, LoopHalt, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { formatTokens } from "@/views/usage/format";
import type { SessionActivityStatus } from "@/store/sessionActivityStore";
import {
  checkOutcomes,
  clockTime,
  failedFirst,
  failedStep,
  failingBefore,
  formatDuration,
  lastLine,
  notesGiven,
  setupOutcomes,
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

/** Why the head of the timeline is where it is. */
export type Head =
  /** An iteration building, being checked or judged. */
  | {
      kind: "live";
      step: Step;
      /** The Build's session, while there is one. */
      activity: { status: SessionActivityStatus; since: number } | null;
    }
  /** Stopped through `loop_blocked`, its question waiting for an answer. */
  | { kind: "blocked" }
  /** Refused by a usage limit, running again once it resets. */
  | { kind: "gated"; label: string; agentId: string; resumeAt: string; backoff: boolean }
  | { kind: "halted"; halt: Exclude<LoopHalt, "Blocked"> }
  | { kind: "signoff" }
  | { kind: "merge" };

type Held = Exclude<Head, { kind: "live" } | { kind: "blocked" }>;

/** The iteration that heads the timeline, and why. */
export interface CurrentState {
  iteration: LoopIteration;
  head: Head;
}

/** What the head card does itself: answer a question, tick a check, deal with a flaky one. */
export interface HeadActions {
  onJoin: (() => void) | null;
  onResume: (answer: string) => void;
  onTick: (checkId: number, ticked: boolean) => void;
  onRerunChecks: () => void;
  /** Opens the flaky check in Checks & settings; null where the loop cannot be edited. */
  onEditCheck: (() => void) | null;
  /** Opens the review of the loop's work, all iterations together; null while it has none. */
  onReview: (() => void) | null;
}

type Tone = "accent" | "warning" | "destructive" | "success" | "muted";

const TEXT: Record<Tone, string> = {
  accent: "text-accent",
  warning: "text-warning",
  destructive: "text-destructive",
  success: "text-success",
  muted: "text-muted-foreground",
};
const BORDER: Record<Tone, string> = {
  accent: "border-accent/30",
  warning: "border-warning/50",
  destructive: "border-destructive/40",
  success: "border-success/40",
  muted: "border-border",
};
const DOT_TONE: Record<Tone, string> = {
  accent: "animate-pulse bg-accent",
  warning: "bg-warning",
  destructive: "bg-destructive",
  success: "bg-success",
  muted: "bg-muted-foreground",
};
const LINK: Record<Tone, string> = {
  accent: "bg-accent/40",
  warning: "bg-warning/50",
  destructive: "bg-destructive/40",
  success: "bg-success/40",
  muted: "bg-border",
};
const FROM: Record<Tone, string> = {
  accent: "from-accent",
  warning: "from-warning",
  destructive: "from-destructive",
  success: "from-success",
  muted: "from-border",
};

interface RingProps {
  share: number;
  tone: Tone;
  big: React.ReactNode;
  small: string;
  glow?: "accent" | "warning";
  label: string;
}

/** The timeline's node: a ring filled to `share`, two short lines in it. */
function Ring({ share, tone, big, small, glow, label }: RingProps) {
  const r = 34;
  const length = 2 * Math.PI * r;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "relative grid size-[72px] shrink-0 place-items-center rounded-full bg-card",
        glow === "accent" && "animate-glow-accent",
        glow === "warning" && "animate-glow-warning",
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
          className={cn("transition-[stroke-dashoffset] duration-700", TEXT[tone])}
        />
      </svg>
      <div className="text-center leading-none">
        <div className="text-sm font-bold tabular-nums">{big}</div>
        <div className="mt-0.5 text-[9px] text-muted-foreground">{small}</div>
      </div>
    </div>
  );
}

/**
 * The Build clock of an iteration in progress: while it builds, the time used against
 * `max_build_secs`; once the Build is done, full, with the iteration's time so far. Its own
 * component so only it ticks.
 */
function LiveRing({
  iteration,
  building,
  limitSecs,
  amber,
}: {
  iteration: LoopIteration;
  building: boolean;
  limitSecs: number;
  amber: boolean;
}) {
  const now = useNow(30_000);
  const used = secsBetween(iteration.started_at, now);
  const late = building && limitSecs - used <= 10 * 60;
  return (
    <Ring
      share={building ? Math.min(1, used / limitSecs) : 1}
      tone={amber ? "warning" : !building ? "success" : late ? "destructive" : "accent"}
      big={formatDuration(used)}
      small={building ? `of ${formatDuration(limitSecs)}` : "so far"}
      glow={amber ? "warning" : "accent"}
      label={
        building ? `Build: ${formatDuration(used)} of ${formatDuration(limitSecs)}` : "Build done"
      }
    />
  );
}

/** How long the agent has been at what it is doing; nothing under a minute. */
function Since({ since }: { since: number }) {
  const now = useNow(30_000);
  const secs = (now - since) / 1000;
  return secs < 60 ? null : <span>for {formatDuration(secs)}</span>;
}

type TileState = "done" | "live" | "waiting" | "failed" | "todo";

interface Tile {
  label: string;
  icon: typeof Check;
  sub: React.ReactNode;
  state: TileState;
  /** Runs only when the steps before it pass. */
  optional?: boolean;
}

function StepTile({
  label,
  icon: Icon,
  sub,
  state,
  optional,
  selected,
  onSelect,
}: Tile & { selected: boolean; onSelect: (() => void) | null }) {
  const Box = onSelect ? "button" : "div";
  return (
    <Box
      {...(onSelect && { type: "button", "aria-pressed": selected, onClick: onSelect })}
      className={cn(
        "relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5 text-left",
        onSelect && "hover:brightness-110",
        selected && "ring-2 ring-foreground/25",
        state === "done" && "border-success/40 bg-success/5",
        state === "live" && "border-accent/50 bg-accent/10",
        state === "waiting" && "border-warning/60 bg-warning/10",
        state === "failed" && "border-destructive/40 bg-destructive/5",
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
            state === "failed" && "text-destructive",
            state === "todo" && "text-muted-foreground",
          )}
        />
      )}
      <div className="min-w-0">
        <div
          className={cn(
            "text-sm",
            state !== "done" && state !== "todo" && "font-semibold",
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
    </Box>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const changed = (iteration: LoopIteration) =>
  iteration.files === 0 ? (
    "No changes"
  ) : (
    <span className="tabular-nums">
      {plural(iteration.files, "file")} <span className="text-success">+{iteration.added}</span>{" "}
      <span className="text-destructive">−{iteration.removed}</span>
    </span>
  );

const lasted = (iteration: LoopIteration) =>
  secsBetween(iteration.started_at, Date.parse(iteration.ended_at ?? iteration.started_at));

/** What the user's tile says while a halt waits on them. */
const YOURS: Record<Exclude<LoopHalt, "Blocked">, string> = {
  Paused: "resume when ready",
  Stopped: "resume when ready",
  Flaky: "fix or remove the check",
  Conflict: "commit or revert, then resume",
  Stalled: "resume when ready",
  Failing: "resume when ready",
  OutOfIterations: "raise the limit to go on",
};

/** A held loop's iteration through its steps, from the results it recorded. */
function heldTiles(head: Held, iteration: LoopIteration, checks: LoopCheck[]): Tile[] {
  const outcomes = checkOutcomes(iteration, checks);
  const commands = outcomes.filter((o) => o.check.kind === "Command");
  const judge = outcomes.find((o) => o.check.kind === "Judge");
  const passed = commands.filter((o) => o.result?.state === "Pass").length;
  const flaky = commands.find((o) => o.result?.state === "Flaky");
  const ran = commands.some((o) => o.result);
  const stepFailed = failedStep(iteration, checks);
  const tiles: Tile[] = [
    head.kind === "gated"
      ? {
          label: "Build",
          icon: Hourglass,
          sub: `${head.label} · resumes ${clockTime(head.resumeAt)}`,
          state: "waiting",
        }
      : iteration.outcome === "Interrupted"
        ? {
            label: "Build",
            icon: Hammer,
            sub: `cut off at ${formatDuration(lasted(iteration))}`,
            state: "failed",
          }
        : {
            label: "Build",
            icon: Hammer,
            sub: `done in ${formatDuration(lasted(iteration))}`,
            state: "done",
          },
  ];
  if (head.kind === "halted" && head.halt === "Conflict") {
    tiles.push({ label: "Merge back", icon: GitMerge, sub: "changes in the way", state: "failed" });
  } else {
    tiles.push({
      label: "Checks",
      icon: flaky ? Dice5 : Terminal,
      sub: stepFailed
        ? `did not run: step ${stepFailed.n} failed`
        : flaky
          ? `"${flaky.check.label}" is flaky`
          : ran
            ? `${passed} of ${plural(commands.length, "command")} pass`
            : "did not run",
      state: stepFailed
        ? "failed"
        : flaky
          ? "waiting"
          : !ran
            ? "todo"
            : passed === commands.length
              ? "done"
              : "failed",
    });
    if (judge) {
      const verdict = judge.result?.state;
      tiles.push({
        label: "Judge",
        icon: Gavel,
        sub: !verdict ? "not reached" : verdict === "Pass" ? "passed" : "failed",
        state: !verdict ? "todo" : verdict === "Pass" ? "done" : "failed",
        optional: true,
      });
    }
  }
  if (head.kind === "merge") {
    tiles.push({ label: "Merge", icon: GitPullRequest, sub: "pull request open", state: "live" });
  } else if (head.kind === "signoff") {
    const manual = outcomes.filter((o) => o.check.kind === "Manual");
    const ticked = manual.filter((o) => o.check.state === "Pass").length;
    tiles.push({
      label: "You",
      icon: User,
      sub: manual.length
        ? `${ticked} of ${plural(manual.length, "check")} ticked`
        : "review and approve",
      state: "waiting",
    });
  } else if (head.kind === "halted") {
    tiles.push({ label: "You", icon: User, sub: YOURS[head.halt], state: "waiting" });
  }
  return tiles;
}

/** The head card's tone, status word and ring for a loop that waits rather than works. */
function heldLook(
  task: Task,
  head: Held,
  iteration: LoopIteration,
): { tone: Tone; word: string; ring: RingProps } {
  const config = task.loop_config;
  const used = lasted(iteration);
  const ring = (
    tone: Tone,
    small: string,
    share = 1,
    big: React.ReactNode = formatDuration(used),
  ): RingProps => ({ share, tone, big, small, label: `Iteration ${iteration.n}: ${small}` });
  switch (head.kind) {
    case "gated":
      return {
        tone: "warning",
        word: head.backoff
          ? `${head.agentId} hit its usage limit`
          : `Waiting for the ${head.label.toLowerCase()}`,
        ring: { ...ring("warning", "resumes", 1, clockTime(head.resumeAt)), glow: "warning" },
      };
    case "signoff":
      return { tone: "warning", word: "Ready for you", ring: ring("success", "all pass") };
    case "merge":
      return { tone: "success", word: "Pull request open", ring: ring("success", "checks pass") };
    case "halted":
      switch (head.halt) {
        case "Paused":
          return { tone: "muted", word: "Paused", ring: ring("muted", "paused") };
        case "Stopped":
          return iteration.outcome === "Interrupted"
            ? {
                tone: "muted",
                word: "Interrupted",
                ring: ring(
                  "muted",
                  "cut off",
                  Math.min(1, used / (config?.max_build_secs ?? 7200)),
                ),
              }
            : { tone: "muted", word: "Stopped", ring: ring("muted", "stopped") };
        case "Flaky":
          return {
            tone: "warning",
            word: "Paused: a check is flaky",
            ring: ring("warning", "paused"),
          };
        // Halts the loop decided on: they wait on the user, nothing broke.
        case "Conflict":
          return {
            tone: "warning",
            word: "Halted: could not merge back",
            ring: ring("warning", "halted"),
          };
        case "Stalled":
          return {
            tone: "warning",
            word: `Halted: ${config?.stall_limit ?? "several"} iterations changed nothing`,
            ring: ring("warning", "halted"),
          };
        case "Failing":
          return {
            tone: "warning",
            word: "Halted: the last three iterations failed",
            ring: ring("warning", "halted"),
          };
        case "OutOfIterations":
          return {
            tone: "warning",
            word: "Out of iterations",
            ring: ring("warning", `of ${config?.max_iterations ?? "?"} used`, 1, iteration.n),
          };
      }
  }
}

/** Why a held loop waits, in one paragraph. It explains; the footer holds what to do about it. */
function heldReason(task: Task, head: Held, iteration: LoopIteration): string {
  if (head.kind === "gated") {
    return `The refused attempt is kept as a WIP commit and runs again at ${clockTime(head.resumeAt)}, without counting. The next session never sees the error.`;
  }
  if (head.kind === "signoff") {
    return "Review the changes to approve them, or send the loop back with a note that goes into the next iteration.";
  }
  if (head.kind === "merge") {
    return "The digest is the pull request's description. Same merge step as every task.";
  }
  switch (head.halt) {
    case "Paused":
      return `Paused after #${iteration.n}, as you asked. Resume starts #${iteration.n + 1}, with any note you add.`;
    case "Stopped":
      return iteration.outcome === "Interrupted"
        ? `Its work so far is kept as a WIP commit. Resume runs #${iteration.n} again from there, and this attempt does not count.`
        : `Stopped, as you asked. Resume starts #${iteration.n + 1}, with any note you add.`;
    case "Flaky":
      return `It failed, then passed when run again on the same commit, so the loop waits rather than spend iterations on it. Fix the test in the loop's worktree or remove the check, then re-run the checks: they run on the loop's worktree as it is, and cost no iteration.`;
    case "Conflict":
      return "The loop's worktree has changes in the way of this iteration's commit, which is kept. Commit or revert them there, then resume: the next iteration merges it first.";
    case "OutOfIterations":
      return `It used all ${plural(task.loop_config?.max_iterations ?? iteration.n, "iteration")} without every check passing. Raising the limit in Checks & settings lets it go on.`;
    case "Stalled":
      return "Its last iterations committed nothing, so it halted rather than spend more. What the agent said is below.";
    case "Failing":
      return "Its last iterations failed, so it halted rather than spend more. What the agent said is below.";
  }
}

/** What a waiting loop's last step says: why it waits on the user, and what they can do there. */
function HeldBody({
  task,
  head,
  iteration,
  checks,
  digest,
  actions,
}: {
  task: Task;
  head: Held;
  iteration: LoopIteration;
  checks: LoopCheck[];
  digest: string | undefined;
  actions: HeadActions;
}) {
  const halt = head.kind === "halted" ? head.halt : null;
  const outcomes = checkOutcomes(iteration, checks);
  const flaky = outcomes.filter((o) => o.result?.state === "Flaky");
  const manual = outcomes.filter((o) => o.check.kind === "Manual");
  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {heldReason(task, head, iteration)}
      </p>
      {halt === "Flaky" && flaky.length > 0 && (
        <div className="space-y-2">
          <CheckCards
            outcomes={flaky}
            open={new Set(flaky.map((o) => o.check.id))}
            onToggle={() => {}}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={actions.onRerunChecks}>
              <Repeat className="size-3" />
              Re-run checks
            </Button>
            {actions.onEditCheck && (
              <Button size="sm" variant="outline" onClick={actions.onEditCheck}>
                <Pencil className="size-3" />
                Edit the check
              </Button>
            )}
          </div>
        </div>
      )}
      {head.kind === "signoff" && manual.length > 0 && (
        <ul className="space-y-1 rounded-md border border-border bg-background p-2 text-xs">
          {manual.map(({ check }) => (
            <li key={check.id}>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={check.state === "Pass"}
                  onCheckedChange={(ticked) => actions.onTick(check.id, ticked)}
                />
                <span className="flex-1">{check.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {head.kind === "signoff" && manual.some(({ check }) => check.state !== "Pass") && (
        <p className="text-xs text-muted-foreground">
          Approving needs every box ticked. If one fails, send the loop back with a note.
        </p>
      )}
      {(head.kind === "signoff" || head.kind === "merge") && digest && (
        <section className="space-y-1.5">
          <h3 className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <BookOpen className="size-3.5" />
              Review digest
            </span>
            <span className="font-normal normal-case tracking-normal">
              by the judge, from the notes, iterations and diff
            </span>
          </h3>
          <div className={MARKDOWN_BOX}>
            <MarkdownBlock text={digest} projectId={task.project_id} />
          </div>
        </section>
      )}
    </div>
  );
}

/** What the agent works on this time: the checks it left failing, the notes it was given. */
function WorkingOn({
  iteration,
  iterations,
  checks,
  comments,
}: {
  iteration: LoopIteration;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
}) {
  const failing = failingBefore(iterations, iteration, checks);
  const notes = notesGiven(comments, iterations, iteration);
  return (
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
            <span className="truncate font-mono text-[11px] text-muted-foreground">{f.line}</span>
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
  );
}

/** The question an iteration stopped on, and the answer that resumes the loop. */
function Question({
  task,
  iteration,
  onResume,
}: {
  task: Task;
  iteration: LoopIteration;
  onResume: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  return (
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
          {iteration.files === 0 ? (
            "It changed nothing, and the checks did not run."
          ) : (
            <>Its work ({changed(iteration)}) is committed and the checks did not run.</>
          )}
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
  );
}

/** The head card of an iteration at work, or stopped on its question. */
function workingCard(
  task: Task,
  current: CurrentState & { head: { kind: "live" | "blocked" } },
  checks: LoopCheck[],
  commands: number,
  judged: boolean,
) {
  const { iteration, head } = current;
  // The round runs the steps, then the checks, in order: the first without a result is running.
  const steps = setupOutcomes(iteration, checks);
  const run = checkOutcomes(iteration, checks).filter((o) => o.check.kind === "Command");
  const stepAt = steps.findIndex((o) => !o.result);
  const checkAt = run.findIndex((o) => !o.result);
  const stepFailed = failedStep(iteration, checks);
  const config = task.loop_config;
  const blocked = head.kind === "blocked";
  const step = head.kind === "live" ? head.step : 0;
  const activity = head.kind === "live" ? head.activity : null;
  const asking = step === 0 && activity?.status === "awaiting_input";
  const doing = activity ? DOING[activity.status] : "Working";
  const tone: Tone = blocked || asking ? "warning" : "accent";
  const ring = blocked ? (
    <Ring
      share={Math.min(1, lasted(iteration) / (config?.max_build_secs ?? 7200))}
      tone="warning"
      big={formatDuration(lasted(iteration))}
      small="stopped"
      label={`Build stopped after ${formatDuration(lasted(iteration))}`}
    />
  ) : (
    <LiveRing
      iteration={iteration}
      building={step === 0}
      limitSecs={config?.max_build_secs ?? 7200}
      amber={asking}
    />
  );
  const tiles: Tile[] = [
    {
      label: "Build",
      icon: Hammer,
      sub: blocked ? (
        `stopped after ${formatDuration(lasted(iteration))}`
      ) : step > 0 ? (
        "done"
      ) : (
        <>
          {doing} {activity && <Since since={activity.since} />}
        </>
      ),
      state: step > 0 ? "done" : tone === "warning" ? "waiting" : "live",
    },
    {
      label: "Checks",
      icon: Terminal,
      sub:
        step > 1
          ? `${commands} of ${commands} commands pass`
          : step === 1 && stepFailed
            ? `step ${stepFailed.n} failed`
            : step === 1 && stepAt >= 0
              ? `step ${stepAt + 1} of ${steps.length} · ${steps[stepAt].check.label}`
              : step === 1 && checkAt >= 0
                ? `check ${checkAt + 1} of ${run.length} · ${run[checkAt].check.label}`
                : steps.length > 0
                  ? `${plural(steps.length, "step")}, then ${plural(commands, "command")}`
                  : plural(commands, "command"),
      state: step === 1 ? "live" : step > 1 ? "done" : "todo",
    },
  ];
  if (judged) {
    tiles.push({
      label: "Judge",
      icon: Gavel,
      sub: step === 2 ? "reading the changes" : "if every command passes",
      state: step === 2 ? "live" : "todo",
      optional: true,
    });
  }
  const word = blocked ? "Blocked" : step === 1 ? "Running checks" : step === 2 ? "Judging" : doing;
  return { tone, word, ring, tiles, asking };
}

/** The head of the timeline: the ring on the rail, and beside it the iteration's card. */
function HeadIteration({
  task,
  current,
  iterations,
  checks,
  comments,
  digest,
  notes,
  actions,
  railBelow,
}: {
  task: Task;
  current: CurrentState;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
  digest: string | undefined;
  notes: string | null | undefined;
  actions: HeadActions;
  /** Earlier iterations follow, so the rail runs on down to them. */
  railBelow: boolean;
}) {
  const { iteration, head } = current;
  const config = task.loop_config;
  const hold = task.loop_summary?.hold;
  const real = checks.filter((c) => !c.proposed || c.accepted);
  const commands = real.filter((c) => c.kind === "Command").length;
  const judged = real.some((c) => c.kind === "Judge");
  const live = head.kind === "live";

  let tone: Tone;
  let word: string;
  let ring: React.ReactNode;
  let tiles: Tile[];
  let asking = false;
  if (head.kind === "live" || head.kind === "blocked") {
    ({ tone, word, ring, tiles, asking } = workingCard(
      task,
      { iteration, head },
      checks,
      commands,
      judged,
    ));
  } else {
    const look = heldLook(task, head, iteration);
    ({ tone, word } = look);
    ring = <Ring {...look.ring} />;
    tiles = heldTiles(head, iteration, checks);
  }

  // The step at hand shows under the tiles; a step already reached can be picked instead. The pick
  // lapses once the loop moves on to another step.
  const reached = tiles.filter((t) => t.state !== "todo");
  const atHand = reached[reached.length - 1]?.label ?? tiles[0].label;
  const at = `${iteration.n}-${iteration.attempt}-${atHand}`;
  const [picked, setPicked] = useState<{ at: string; label: string } | null>(null);
  const shown = picked?.at === at ? picked.label : atHand;
  const step = head.kind === "live" ? head.step : null;
  const outcomes = checkOutcomes(iteration, checks);
  const panelKey = `${at}-${shown}`;
  let body: React.ReactNode;
  switch (shown) {
    case "Build":
      body =
        head.kind === "blocked" ? (
          <Question task={task} iteration={iteration} onResume={actions.onResume} />
        ) : step === 0 ? (
          <div className="space-y-2">
            <WorkingOn
              iteration={iteration}
              iterations={iterations}
              checks={checks}
              comments={comments}
            />
            <AgentNotes key={panelKey} task={task} notes={notes} />
          </div>
        ) : head.kind === "gated" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {heldReason(task, head, iteration)}
          </p>
        ) : (
          <div className="space-y-2">
            <BuildOutcome task={task} iteration={iteration} />
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Left for the next iteration
              </div>
              <NotesFile task={task} notes={notes} />
            </div>
          </div>
        );
      break;
    case "Checks":
      body = (
        <ChecksPanel
          key={panelKey}
          iteration={iteration}
          checks={checks}
          outcomes={outcomes.filter((o) => o.check.kind === "Command")}
          running={step === 1}
        />
      );
      break;
    case "Judge":
      body = (
        <JudgeVerdicts
          task={task}
          outcomes={outcomes.filter((o) => o.check.kind === "Judge")}
          running={step === 2}
        />
      );
      break;
    case "Merge back":
      body = (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
          {iteration.check_output?.trim() || "Git gave no output."}
        </pre>
      );
      break;
    default:
      body = head.kind !== "live" && head.kind !== "blocked" && (
        <HeldBody
          task={task}
          head={head}
          iteration={iteration}
          checks={checks}
          digest={digest}
          actions={actions}
        />
      );
  }

  return (
    <li className={cn("relative pb-4", INDENT)}>
      {railBelow && (
        <span
          className={cn(
            "absolute bottom-0 top-[80px] w-0.5 bg-gradient-to-b to-border",
            RAIL,
            FROM[tone],
          )}
        />
      )}
      <span className="absolute left-0 top-2">{ring}</span>
      <span className={cn("absolute left-[72px] top-[43px] h-0.5 w-4", LINK[tone])} />
      <section className={cn("space-y-3 rounded-xl border bg-card p-4", BORDER[tone])}>
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tabular-nums">#{iteration.n}</span>
          <span className="text-xs text-muted-foreground">
            of {config?.max_iterations ?? "?"} ·{" "}
            {iteration.ended_at && !live
              ? `ended ${time(iteration.ended_at)}`
              : `started ${time(iteration.started_at)}`}
          </span>
          <span
            className={cn(
              "ml-1 flex items-center gap-2 text-sm font-medium",
              tone !== "accent" && TEXT[tone],
            )}
          >
            <span className={cn("size-2.5 rounded-full", DOT_TONE[tone])} />
            {word}
          </span>
          <div className="flex-1" />
          {live && hold && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {hold === "Stopped" ? <OctagonX className="size-3" /> : <Pause className="size-3" />}
              {hold === "Stopped" ? "Stops" : "Pauses"} once this step ends
            </span>
          )}
          {iteration.tokens != null && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTokens(iteration.tokens)} tokens
            </span>
          )}
          {!live && iteration.outcome !== "Interrupted" && (
            <span className="text-xs text-muted-foreground">{changed(iteration)}</span>
          )}
          {actions.onReview && !live && head.kind !== "signoff" && (
            <Button size="sm" variant="outline" onClick={actions.onReview}>
              Review changes
            </Button>
          )}
          {actions.onJoin && live && (
            <Button
              size="sm"
              variant="outline"
              className={cn(asking && "border-warning/60 text-warning")}
              onClick={actions.onJoin}
            >
              <CornerDownRight className="size-3" />
              {asking ? "Join to answer" : "Join"}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {tiles.map((tile, i) => (
            <Fragment key={tile.label}>
              {i > 0 && <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />}
              <StepTile
                {...tile}
                selected={reached.length > 1 && tile.label === shown}
                onSelect={
                  reached.length > 1 && tile.state !== "todo"
                    ? () => setPicked({ at, label: tile.label })
                    : null
                }
              />
            </Fragment>
          ))}
        </div>

        {body}
      </section>
    </li>
  );
}

/** A finished loop's head: one line, its ring a check. */
function DoneHead({ task, railBelow }: { task: Task; railBelow: boolean }) {
  const summary = task.loop_summary;
  return (
    <li className={cn("relative pb-4", INDENT)}>
      {railBelow && (
        <span
          className={cn(
            "absolute bottom-0 top-[72px] w-0.5 bg-gradient-to-b from-success to-border",
            RAIL,
          )}
        />
      )}
      <span className="absolute left-0 top-0">
        <Ring
          share={1}
          tone="success"
          big={<Check className="mx-auto size-5 text-success" />}
          small="done"
          label="Done"
        />
      </span>
      <span className={cn("absolute left-[72px] top-[35px] h-0.5 w-4", LINK.success)} />
      <section className="flex min-h-[72px] items-center gap-2 rounded-xl border border-success/40 bg-card px-4 text-sm font-medium">
        <CircleCheck className="size-4 shrink-0 text-success" />
        Done after {plural(summary?.counted ?? 0, "iteration")} and{" "}
        {formatDuration(summary?.agent_secs ?? 0)}.
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
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
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

/** The steps before the checks, then the checks, as one round ran them. */
function ChecksPanel({
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
      <div className={heading}>Before the checks</div>
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
function JudgeVerdicts({
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
              "space-y-2 rounded-md border p-3 text-xs",
              failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-background",
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

const MARKDOWN_BOX =
  "rounded-md border border-border bg-background p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold";

/** What the agent wrote when its Build ended, or the question it stopped on. */
function AgentSummary({ task, iteration }: { task: Task; iteration: LoopIteration }) {
  return (
    <div className={MARKDOWN_BOX}>
      {iteration.summary || iteration.blocked ? (
        <MarkdownBlock
          text={iteration.summary ?? iteration.blocked ?? ""}
          projectId={task.project_id}
        />
      ) : (
        <span className="text-muted-foreground">The agent wrote no summary.</span>
      )}
    </div>
  );
}

/**
 * The agent's own notes, `.maestro/loop/PROGRESS.md` in the loop's worktree: the loop's memory,
 * which every fresh session reads first and updates before it stops. `.maestro/` is excluded from
 * git, so they are never committed.
 */
function NotesFile({ task, notes }: { task: Task; notes: string | null | undefined }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono">.maestro/loop/PROGRESS.md</span>
        <span className="text-muted-foreground">written by the agent, never committed</span>
      </div>
      <div className="p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
        {notes?.trim() ? (
          <MarkdownBlock text={notes} projectId={task.project_id} />
        ) : (
          <span className="text-muted-foreground">The agent left no notes.</span>
        )}
      </div>
    </div>
  );
}

/** While the agent builds, its notes behind one line: it read them first and updates them as it goes. */
function AgentNotes({ task, notes }: { task: Task; notes: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const lines = notes?.trim() ? notes.trim().split("\n").length : 0;
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <NotebookPen className="size-3.5" />
        It read the agent notes first
        <span>· {lines ? plural(lines, "line") : "none yet"}</span>
      </button>
      {open && <NotesFile task={task} notes={notes} />}
    </div>
  );
}

/** A finished Build: what the agent wrote, and git's reason when its work could not be committed. */
function BuildOutcome({ task, iteration }: { task: Task; iteration: LoopIteration }) {
  return (
    <div className="space-y-2">
      <AgentSummary task={task} iteration={iteration} />
      {iteration.outcome === "Failed" && iteration.check_output && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] leading-relaxed">
          {iteration.check_output.trim()}
        </pre>
      )}
    </div>
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
    // A failed commit or merge back records git's reason; the agent failing records none.
    case "Failed":
      return iteration.check_output?.startsWith("The iteration's commit failed")
        ? "commit failed"
        : iteration.check_output?.includes("could not be merged")
          ? "merge failed"
          : "the agent failed";
    case "Blocked":
      return "blocked, checks not run";
    default:
      return null;
  }
}

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
          <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
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
function IterationRow({
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
              {iteration.tokens != null && (
                <span className="shrink-0 tabular-nums">
                  {formatTokens(iteration.tokens)} tokens
                </span>
              )}
              {iteration.outcome !== "Interrupted" && (
                <span className="shrink-0">{changed(iteration)}</span>
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
        {open && (
          <div className="px-3 pb-3 pl-[68px]">
            <IterationDetail task={task} iteration={iteration} checks={checks} />
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
      <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
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
