import { Fragment, useState } from "react";
import {
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

function StepTile({ label, icon: Icon, sub, state, optional }: Tile) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5",
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

const lasted = (iteration: LoopIteration) =>
  secsBetween(iteration.started_at, Date.parse(iteration.ended_at ?? iteration.started_at));

/** What the user's tile says while a halt waits on them. */
const YOURS: Record<Exclude<LoopHalt, "Blocked">, string> = {
  Paused: "resume when ready",
  Stopped: "resume when ready",
  Flaky: "fix or remove the check",
  Conflict: "commit or revert, then resume",
  Stalled: "add a note and resume",
  Failing: "add a note and resume",
  OutOfIterations: "raise the limit or add a note",
};

/** A held loop's iteration through its steps, from the results it recorded. */
function heldTiles(head: Held, iteration: LoopIteration, checks: LoopCheck[]): Tile[] {
  const outcomes = checkOutcomes(iteration, checks);
  const commands = outcomes.filter((o) => o.check.kind === "Command");
  const judge = outcomes.find((o) => o.check.kind === "Judge");
  const passed = commands.filter((o) => o.result?.state === "Pass").length;
  const flaky = commands.find((o) => o.result?.state === "Flaky");
  const ran = commands.some((o) => o.result);
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
      sub: flaky
        ? `"${flaky.check.label}" is flaky`
        : ran
          ? `${passed} of ${plural(commands.length, "command")} pass`
          : "did not run",
      state: flaky ? "waiting" : !ran ? "todo" : passed === commands.length ? "done" : "failed",
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
        case "Conflict":
          return {
            tone: "destructive",
            word: "Stopped: could not merge back",
            ring: ring("destructive", "stopped"),
          };
        case "Stalled":
          return {
            tone: "destructive",
            word: `Stopped: ${config?.stall_limit ?? "several"} iterations changed nothing`,
            ring: ring("destructive", "stopped"),
          };
        case "Failing":
          return {
            tone: "destructive",
            word: "Stopped: the last three iterations failed",
            ring: ring("destructive", "stopped"),
          };
        case "OutOfIterations":
          return {
            tone: "destructive",
            word: "Out of iterations",
            ring: ring("destructive", `of ${config?.max_iterations ?? "?"} used`, 1, iteration.n),
          };
      }
  }
}

/** Why a held loop waits, in one paragraph. It explains; the footer holds what to do about it. */
function heldReason(task: Task, head: Held, iteration: LoopIteration): string {
  const base = task.base_branch || "the base branch";
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
      return `It failed, then passed when run again on the same commit, so the loop waits rather than spend iterations on it. Fix the test on ${base} or remove the check, then re-run the checks: that takes the hidden files from ${base} again and costs no iteration.`;
    case "Conflict":
      return "The loop's worktree has changes in the way of this iteration's commit, which is kept. Commit or revert them there, then resume: the next iteration merges it first.";
    case "OutOfIterations":
      return "Raise the limit in Checks & settings and save, or add a note and resume.";
    default:
      return "Add a note and resume.";
  }
}

/** What a waiting loop's card says under its steps. */
function HeldBody({
  task,
  head,
  iteration,
  checks,
  actions,
}: {
  task: Task;
  head: Held;
  iteration: LoopIteration;
  checks: LoopCheck[];
  actions: HeadActions;
}) {
  const [details, setDetails] = useState(false);
  const outcomes = checkOutcomes(iteration, checks);
  const flaky = outcomes.filter((o) => o.result?.state === "Flaky");
  const manual = outcomes.filter((o) => o.check.kind === "Manual");
  const halt = head.kind === "halted" ? head.halt : null;
  const lastNote = task.loop_summary?.last_summary;
  const hasDetails = iteration.results.length > 0 || !!iteration.summary;
  return (
    <div className="space-y-2.5">
      {(halt === "Stalled" || halt === "Failing" || halt === "OutOfIterations") && lastNote && (
        <p className="text-xs leading-relaxed">
          <span className="font-medium">The agent's last note:</span> “{lastNote}”
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {heldReason(task, head, iteration)}
      </p>
      {halt === "Conflict" && iteration.check_output && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
          {iteration.check_output.trim()}
        </pre>
      )}
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
            <li key={check.id} className="flex items-center gap-2">
              {check.state === "Pass" ? (
                <Check className="size-3.5 shrink-0 text-success" />
              ) : (
                <User className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1">{check.label}</span>
              <button
                type="button"
                className="shrink-0 text-accent hover:underline"
                onClick={() => actions.onTick(check.id, check.state !== "Pass")}
              >
                {check.state === "Pass" ? "Untick" : "Mark done"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasDetails && head.kind !== "gated" && (
        <>
          <button
            type="button"
            aria-expanded={details}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDetails(!details)}
          >
            {details ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Checks and outcome of #{iteration.n}
          </button>
          {details && <IterationDetail task={task} iteration={iteration} checks={checks} />}
        </>
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
  );
}

/** The head card of an iteration at work, or stopped on its question. */
function workingCard(
  task: Task,
  current: CurrentState & { head: { kind: "live" | "blocked" } },
  commands: number,
  judged: boolean,
) {
  const { iteration, head } = current;
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
          : config?.setup_command
            ? `Run first, then ${plural(commands, "command")}`
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
  actions,
  railBelow,
}: {
  task: Task;
  current: CurrentState;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
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
  let body: React.ReactNode;
  let asking = false;
  if (head.kind === "live" || head.kind === "blocked") {
    const card = workingCard(task, { iteration, head }, commands, judged);
    ({ tone, word, ring, tiles, asking } = card);
    body =
      head.kind === "blocked" ? (
        <Question task={task} iteration={iteration} onResume={actions.onResume} />
      ) : (
        <WorkingOn
          iteration={iteration}
          iterations={iterations}
          checks={checks}
          comments={comments}
        />
      );
  } else {
    const look = heldLook(task, head, iteration);
    ({ tone, word } = look);
    ring = <Ring {...look.ring} />;
    tiles = heldTiles(head, iteration, checks);
    body = (
      <HeldBody task={task} head={head} iteration={iteration} checks={checks} actions={actions} />
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
              <StepTile {...tile} />
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
  const [openChecks, setOpenChecks] = useState<Set<number>>(() => {
    const failed = failedFirst(outcomes).find((o) => o.result && o.result.state !== "Pass");
    return new Set(failed ? [failed.check.id] : []);
  });
  const ran = iteration.results.length > 0;
  const note = sideNote(iteration);
  return (
    <div className="grid grid-cols-2 gap-4">
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
  actions,
}: {
  task: Task;
  iterations: LoopIteration[];
  checks: LoopCheck[];
  comments: TaskComment[];
  current: CurrentState | null;
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
