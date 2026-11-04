import { Fragment, useState, type ReactNode } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  CornerDownRight,
  NotebookPen,
  OctagonX,
  Pause,
  Pencil,
  Play,
  Repeat,
  StickyNote,
  X,
} from "lucide-react";
import type { LoopCheck, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { formatTimeOfDay, formatTokens, plural } from "@/lib/format-utils";
import { Reveal } from "@/components/common/Reveal";
import { MarkdownBlock } from "@/components/common/markdown/MarkdownBlock";
import {
  checkOutcomes,
  failingBefore,
  formatDuration,
  heldLook,
  heldReason,
  heldTiles,
  iterationSecs,
  notesGiven,
  workingCard,
  type CurrentState,
  type Held,
  type LiveRingSpec,
  type RingProps,
  type Tile,
  type Tone,
} from "./loop-state";
import { CheckCards, ChecksPanel, JudgeVerdicts } from "./CheckCards";
import { AgentSummary, Changed, INDENT, MARKDOWN_BOX, NotesFile, RAIL } from "./IterationParts";

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

const TEXT: Record<Tone, string> = {
  accent: "text-accent",
  warning: "text-warning",
  destructive: "text-destructive",
  success: "text-success",
  muted: "text-muted-foreground",
};
const BORDER: Record<Tone, string> = {
  accent: "border-accent/30!",
  warning: "border-warning/50!",
  destructive: "border-destructive/40!",
  success: "border-success/40!",
  muted: "",
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

/** The timeline's node: a ring filled to `share`, two short lines in it. */
function Ring({
  share,
  tone,
  big,
  small,
  glow,
  label,
}: Omit<RingProps, "big"> & { big: ReactNode }) {
  const r = 34;
  const length = 2 * Math.PI * r;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "relative grid size-[72px] shrink-0 place-items-center rounded-full bg-background/50",
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
  const used = iterationSecs(iteration, now);
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

function StepTile({
  label,
  icon: Icon,
  sub,
  since,
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
        state === "todo" &&
          (optional ? "border-dashed border-foreground/10" : "border-foreground/10"),
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
        <div className="truncate text-[11px] tabular-nums text-muted-foreground">
          {sub}
          {since != null && (
            <>
              {" "}
              <Since since={since} />
            </>
          )}
        </div>
      </div>
      {state === "live" && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-foreground/10">
          <div className="absolute inset-y-0 left-0 w-[60%] animate-rail-comet bg-gradient-to-r from-transparent via-accent/50 to-accent" />
        </div>
      )}
    </Box>
  );
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
        <ul className="space-y-1 rounded-lg border border-foreground/7 bg-background/50 p-2 text-xs">
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
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-foreground/10 bg-accent/5 px-2 py-1 text-xs"
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
      <div className="rounded-lg border border-warning/40 bg-background/50 p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
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
            <>
              Its work (<Changed iteration={iteration} />) is committed and the checks did not run.
            </>
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

/** The head of the timeline: the ring on the rail, and beside it the iteration's card. */
export function HeadIteration({
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
  let ringSpec: RingProps | LiveRingSpec;
  let tiles: Tile[];
  let asking = false;
  if (head.kind === "live" || head.kind === "blocked") {
    ({
      tone,
      word,
      ring: ringSpec,
      tiles,
      asking,
    } = workingCard(task, { iteration, head }, checks, commands, judged));
  } else {
    ({ tone, word, ring: ringSpec } = heldLook(task, head, iteration));
    tiles = heldTiles(head, iteration, checks);
  }
  const ring =
    "live" in ringSpec ? (
      <LiveRing
        iteration={iteration}
        building={ringSpec.building}
        limitSecs={ringSpec.limitSecs}
        amber={ringSpec.amber}
      />
    ) : (
      <Ring {...ringSpec} />
    );

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
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-foreground/7 bg-background/50 p-2 font-mono text-[11px] leading-relaxed">
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
      <section className={cn("glass-tile space-y-3 rounded-[14px] p-4", BORDER[tone])}>
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tabular-nums">#{iteration.n}</span>
          <span className="text-xs text-muted-foreground">
            of {config?.max_iterations ?? "?"} ·{" "}
            {iteration.ended_at && !live
              ? `ended ${formatTimeOfDay(iteration.ended_at)}`
              : `started ${formatTimeOfDay(iteration.started_at)}`}
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
            <span className="inline-flex items-center gap-1 rounded-full border border-foreground/10 px-2 py-0.5 text-[11px] text-muted-foreground">
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
            <span className="text-xs text-muted-foreground">
              <Changed iteration={iteration} />
            </span>
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
export function DoneHead({ task, railBelow }: { task: Task; railBelow: boolean }) {
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
      <section className="flex min-h-[72px] items-center gap-2 glass-tile rounded-[14px] border-success/40! px-4 text-sm font-medium">
        <CircleCheck className="size-4 shrink-0 text-success" />
        Done after {plural(summary?.counted ?? 0, "iteration")} and{" "}
        {formatDuration(summary?.agent_secs ?? 0)}.
      </section>
    </li>
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
        <ChevronRight
          className={cn("size-3 transition-transform duration-200", open && "rotate-90")}
        />
        <NotebookPen className="size-3.5" />
        It read the agent notes first
        <span>· {lines ? plural(lines, "line") : "none yet"}</span>
      </button>
      <Reveal open={open}>
        <NotesFile task={task} notes={notes} />
      </Reveal>
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
