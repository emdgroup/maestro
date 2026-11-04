import type {
  AgentGateState,
  LoopCheck,
  LoopCheckResult,
  LoopCheckState,
  LoopHalt,
  LoopIteration,
  Task,
  TaskComment,
} from "@/types/bindings";
import {
  Dice5,
  Gavel,
  GitMerge,
  GitPullRequest,
  Hammer,
  Hourglass,
  Terminal,
  User,
  type LucideIcon,
} from "lucide-react";
import { formatTimeOfDay, plural } from "@/lib/format-utils";
import type { SessionActivityStatus } from "@/store/sessionActivityStore";

/** What a card says on its phase line, and how loudly. */
export interface StateLine {
  label: string;
  detail?: string;
  tone: "brand" | "warning" | "muted" | "success" | "destructive" | "amber";
  /** Replaces the card's phase-status ring. */
  ring?: string;
}

/** The amber tint the board keeps for "stopped dead, waiting on you". */
export const NEEDS_YOU_RING = "needs-you";
export const GATED_RING = "border-dashed! border-amber-500/60!";

const HALTS: Record<LoopHalt, { label: string; urgent: boolean }> = {
  Flaky: { label: "Flaky check, needs you", urgent: true },
  Failing: { label: "Failing, needs you", urgent: true },
  Stalled: { label: "Stalled, needs your answer", urgent: true },
  OutOfIterations: { label: "Out of iterations, needs you", urgent: true },
  Paused: { label: "Paused", urgent: false },
  Stopped: { label: "Stopped by you", urgent: false },
  Blocked: { label: "Blocked, needs your answer", urgent: true },
  Conflict: { label: "Merge conflict, needs you", urgent: true },
};

/** `15:00`, or `Tue 15:00` once it is not today. */
export function clockTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = formatTimeOfDay(at);
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** `5-hour`, `Weekly`, or nothing when the agent did not say. */
function windowName(gate: AgentGateState): string | null {
  if (gate.window === "five_hour") return "5-hour";
  if (gate.window?.startsWith("seven_day")) return "Weekly";
  return null;
}

/** The line of a task held by its agent's usage-limit gate, pipeline or loop. */
export function gateLine(task: Task, now: Date = new Date()): StateLine | null {
  const gate = task.gate;
  if (!gate || new Date(gate.resume_at) <= now) return null;
  const window = windowName(gate);
  return {
    label: window ? `${window} limit` : "Usage limit",
    detail: `${gate.backoff ? "tries again" : "resumes"} ${clockTime(gate.resume_at, now)}`,
    tone: "amber",
    ring: GATED_RING,
  };
}

/**
 * Why a loop is waiting on the user, or `null` while it is not. A halt is read only in the states
 * the daemon leaves a stopped loop in: `Iterating` waiting on the user, or failed.
 */
export function loopHalt(task: Task): LoopHalt | null {
  const halted =
    task.phase === "Iterating" &&
    task.ball === "User" &&
    (task.phase_status === "Waiting" || task.phase_status === "Failed");
  return halted ? (task.loop_summary?.halt ?? "Stalled") : null;
}

/** The loop's phase line, or `null` where the board's own line says it already. */
export function loopLine(task: Task): StateLine | null {
  if (task.run_mode !== "Loop") return null;
  const summary = task.loop_summary;
  const max = task.loop_config?.max_iterations ?? 0;
  const iteration = summary?.iteration ?? 0;
  const halt = loopHalt(task);
  if (halt) {
    const { label, urgent } = HALTS[halt];
    return {
      label,
      tone: urgent ? "warning" : "brand",
      ring: urgent ? NEEDS_YOU_RING : undefined,
      detail:
        halt === "Stalled" || halt === "Blocked" ? (summary?.last_summary ?? undefined) : undefined,
    };
  }
  const live = task.phase_status === "Running" || task.phase_status === "Blocked";
  const holding =
    summary?.hold === "Paused"
      ? "pausing after this one"
      : summary?.hold === "Stopped"
        ? "stopping after this one"
        : undefined;
  switch (task.phase) {
    case "Spawning":
      if (task.status === "Planning")
        return { label: "Preparing", detail: "starting", tone: "brand" };
      return {
        label: `Iteration ${(summary?.counted ?? 0) + 1}/${max}`,
        detail: "starting",
        tone: "brand",
      };
    case "Iterating":
      return live
        ? {
            label: `Iteration ${iteration}/${max}`,
            detail: holding ?? summary?.last_summary ?? undefined,
            tone: "brand",
          }
        : {
            label: `Iteration ${(summary?.counted ?? 0) + 1}/${max}`,
            detail: "waiting for a slot",
            tone: "muted",
          };
    case "Refining":
      if (task.phase_status === "Failed") return { label: "Preparing failed", tone: "destructive" };
      return task.ball === "User" && task.phase_status === "Waiting"
        ? { label: "Loop prepared", detail: "read its summary", tone: "warning" }
        : { label: "Preparing", tone: "brand" };
    case "Checking":
      return {
        label: "Checking",
        detail: holding ?? `after iteration ${iteration}`,
        tone: "brand",
      };
    case "Judging":
      if (task.phase_status === "Failed") {
        return { label: "Judge failed, needs you", tone: "warning", ring: NEEDS_YOU_RING };
      }
      return {
        label: "Judging",
        detail: live ? holding : "waiting for a slot",
        tone: live ? "brand" : "muted",
      };
    case "Approval":
      return {
        label: "Needs your check",
        detail: summary && summary.proposals > 0 ? "a proposal waits" : "digest ready",
        tone: "warning",
      };
    default:
      return null;
  }
}

/** The loops waiting on the user, as the waiting cap counts them. */
export function loopsWaiting(tasks: Task[]): number {
  return tasks.filter(
    (t) => t.run_mode === "Loop" && t.ball === "User" && t.status !== "Done" && !t.archived_at,
  ).length;
}

/**
 * The line of a queued loop the waiting cap holds back, which the drain will not start on its own.
 * `heldBack` is how many loops wait on the user while the cap holds, `null` while it does not.
 */
export function queuedLine(task: Task, heldBack: number | null): StateLine | null {
  if (
    heldBack === null ||
    task.run_mode !== "Loop" ||
    task.status !== "Queue" ||
    task.phase ||
    task.execute_requested_at
  ) {
    return null;
  }
  return {
    label: "Queued",
    detail:
      heldBack === 1 ? "1 loop already waits on you" : `${heldBack} loops already wait on you`,
    tone: "muted",
  };
}

/** `from Nightly triage #12`, for a task an automation's agent created, while it is a draft. */
export function draftLine(task: Task): StateLine | null {
  const draft = task.drafted_by;
  if (!draft || task.status !== "Planning") return null;
  return {
    label: "Draft",
    detail: `from ${draft.automation}${draft.run != null ? ` #${draft.run}` : ""}`,
    tone: "muted",
  };
}

/** Whether a card shows the check bar: once the loop has run, and never for a draft. */
export function showsCheckBar(task: Task): boolean {
  return (
    task.run_mode === "Loop" &&
    (task.loop_summary?.checks.length ?? 0) > 0 &&
    task.status !== "Planning" &&
    task.status !== "Queue"
  );
}

export const CHECK_SEGMENT: Record<LoopCheckState, string> = {
  Pass: "bg-success",
  Fail: "bg-destructive",
  Flaky: "bg-warning",
  Pending: "bg-muted-foreground/25",
};

/** `2h`, `1h 30m`, `45m`, `0m`. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * What a running Build's bar says of the time it has left: late in its last 10 minutes, when the
 * daemon is about to close it.
 */
export function buildTimeLeft(usedSecs: number, limitSecs: number): { late: boolean; tip: string } {
  const left = limitSecs - usedSecs;
  if (left <= 0) return { late: true, tip: "Closing now" };
  if (left <= 10 * 60) return { late: true, tip: `Closes in ${formatDuration(left)}` };
  return { late: false, tip: `${formatDuration(left)} left` };
}

/** `2h`, `90m`, `1h 30m`, `1.5h`, or a bare number of minutes, in seconds. `null` when unreadable. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 60);
  const match = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(t);
  if (!match || (!match[1] && !match[2])) return null;
  const seconds = parseFloat(match[1] ?? "0") * 3600 + parseInt(match[2] ?? "0", 10) * 60;
  return seconds > 0 ? Math.round(seconds) : null;
}

/**
 * The relative paths a check command names, which the loop may seal: tokens with a `/` or a file
 * extension that are not options, URLs or variables.
 */
export function pathsInCommand(command: string): string[] {
  return command
    .split(/[\s;&|<>()'"`]+/)
    .filter(
      (token) =>
        token.length > 1 &&
        !token.startsWith("-") &&
        !token.startsWith("$") &&
        !token.includes("://") &&
        !token.startsWith("/") &&
        (token.includes("/") || /\.[a-z0-9]+$/i.test(token)),
    )
    .map((token) => token.replace(/^\.\//, ""));
}

/** A sealed pattern's glob as a regular expression over a whole relative path. */
function globRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` is any number of folders, none included; a `**` elsewhere is anything.
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether a path is hidden from the agent, and the entry that decided it. */
export interface Hidden {
  hidden: boolean;
  by: string | null;
}

/**
 * The daemon's reading of a loop's sealed patterns, which gitignore's: anchored at the root unless
 * it starts with `**` and a slash, `*` within one folder, a trailing `/` a folder and everything under it,
 * `!` visible again, and a later entry over an earlier one. A path is decided by the nearest of
 * itself and its folders that an entry matches.
 */
export function hiddenMatcher(patterns: string[]): (path: string) => Hidden {
  const rules = patterns.map((pattern) => {
    const shown = pattern.startsWith("!");
    const body = shown ? pattern.slice(1) : pattern;
    const folder = body.endsWith("/");
    return { pattern, shown, folder, re: globRegex(folder ? body.slice(0, -1) : body) };
  });
  return (path) => {
    const parts = path.split("/");
    for (let end = parts.length; end > 0; end--) {
      const candidate = parts.slice(0, end).join("/");
      const isFolder = end < parts.length;
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        if ((!rule.folder || isFolder) && rule.re.test(candidate)) {
          return { hidden: !rule.shown, by: rule.pattern };
        }
      }
    }
    return { hidden: false, by: null };
  };
}

/** A pattern with a wildcard, which the card lists as a rule rather than a picked path. */
export const isRule = (pattern: string) => !pattern.startsWith("!") && pattern.includes("*");

/** Patterns as they are stored: the rules, then the picked paths, then the exceptions. */
export function orderPatterns(patterns: string[]): string[] {
  const unique = [...new Set(patterns)];
  return [
    ...unique.filter(isRule),
    ...unique.filter((p) => !isRule(p) && !p.startsWith("!")),
    ...unique.filter((p) => p.startsWith("!")),
  ];
}

/** A check of the loop's list and what it concluded after one iteration, `null` where it did not run. */
export interface CheckOutcome {
  check: LoopCheck;
  result: LoopCheckResult | null;
}

function outcomes(iteration: LoopIteration, checks: LoopCheck[], steps: boolean) {
  return checks
    .filter((c) => (!c.proposed || c.accepted) && (c.kind === "Setup") === steps)
    .sort((a, b) => a.position - b.position)
    .map((check) => ({
      check,
      result: iteration.results.find((r) => r.check_id === check.id) ?? null,
    }));
}

/** The loop's checks in list order, its steps and proposals still waiting left out, each with its result. */
export function checkOutcomes(iteration: LoopIteration, checks: LoopCheck[]): CheckOutcome[] {
  return outcomes(iteration, checks, false);
}

/** The steps run before the checks, in order, each with its result. */
export function setupOutcomes(iteration: LoopIteration, checks: LoopCheck[]): CheckOutcome[] {
  return outcomes(iteration, checks, true);
}

/** The step that failed after `iteration`, numbered from 1, so no check ran; `null` if none did. */
export function failedStep(
  iteration: LoopIteration,
  checks: LoopCheck[],
): { n: number; outcome: CheckOutcome } | null {
  const steps = setupOutcomes(iteration, checks);
  const at = steps.findIndex((o) => o.result?.state === "Fail");
  return at < 0 ? null : { n: at + 1, outcome: steps[at] };
}

/**
 * Whether the loop may be signed off, as `require_signed_off` decides: it has checks, every one
 * passes (a manual one once the user ticks it), and no proposal waits for an answer. Its steps
 * only prepare the checks.
 */
export function canSignOff(checks: LoopCheck[]): boolean {
  const real = checks.filter((c) => c.kind !== "Setup");
  return real.length > 0 && real.every((c) => (!c.proposed || c.accepted) && c.state === "Pass");
}

/** Failed and flaky first, then passed, then those that did not run, each kept in list order. */
export function failedFirst(outcomes: CheckOutcome[]): CheckOutcome[] {
  const rank = (o: CheckOutcome) => (!o.result ? 2 : o.result.state === "Pass" ? 1 : 0);
  return [...outcomes].sort((a, b) => rank(a) - rank(b));
}

/** The last line with something on it, which for a test run is usually its count. */
export function lastLine(text: string | null | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

/**
 * What the current iteration works on: the checks the latest earlier round left failing, with their
 * result line, as the prompt gave them.
 */
export function failingBefore(
  iterations: LoopIteration[],
  current: LoopIteration,
  checks: LoopCheck[],
): { label: string; line: string }[] {
  const before = [...iterations].reverse().find((i) => i.n < current.n && i.results.length > 0);
  if (!before) return [];
  return checkOutcomes(before, checks)
    .filter((o) => o.result && o.result.state !== "Pass")
    .map((o) => ({ label: o.check.label, line: lastLine(o.result?.detail) }));
}

/** The notes an iteration's prompt carried: every one written after the previous attempt started. */
export function notesGiven(
  comments: TaskComment[],
  iterations: LoopIteration[],
  current: LoopIteration,
): TaskComment[] {
  const at = iterations.indexOf(current);
  const from = at > 0 ? Date.parse(iterations[at - 1].started_at) : -Infinity;
  const to = Date.parse(current.started_at);
  return comments.filter((c) => {
    const written = Date.parse(c.created_at);
    return c.kind === "steer" && written > from && written <= to;
  });
}

const secsBetween = (from: string, to: number) => Math.max(0, (to - Date.parse(from)) / 1000);

/** How long an iteration has run, or ran: to `now` while it runs, to its end once it has one. */
export function iterationSecs(iteration: LoopIteration, now: number): number {
  return secsBetween(iteration.started_at, now);
}

/** How long a finished iteration ran; zero for one that has not ended. */
export function lasted(iteration: LoopIteration): number {
  return secsBetween(iteration.started_at, Date.parse(iteration.ended_at ?? iteration.started_at));
}

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

/** A head that waits rather than works. */
export type Held = Exclude<Head, { kind: "live" } | { kind: "blocked" }>;

/** The iteration that heads the timeline, and why. */
export interface CurrentState {
  iteration: LoopIteration;
  head: Head;
}

export type Tone = "accent" | "warning" | "destructive" | "success" | "muted";

/** The ring on the timeline's rail: filled to `share`, two short lines in it. */
export interface RingProps {
  share: number;
  tone: Tone;
  big: string | number;
  small: string;
  glow?: "accent" | "warning";
  label: string;
}

/** The ring of an iteration at work, which ticks: its Build clock against `limitSecs`. */
export interface LiveRingSpec {
  live: true;
  building: boolean;
  limitSecs: number;
  amber: boolean;
}

export type TileState = "done" | "live" | "waiting" | "failed" | "todo";

/** One step of an iteration, as a tile in the head card. */
export interface Tile {
  label: string;
  icon: LucideIcon;
  sub: string;
  /** When set, the tile adds how long the agent has been at `sub`, ticking. */
  since?: number;
  state: TileState;
  /** Runs only when the steps before it pass. */
  optional?: boolean;
}

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
export function heldTiles(
  head: Held,
  iteration: LoopIteration,
  checks: LoopCheck[],
  now: Date = new Date(),
): Tile[] {
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
          sub: `${head.label} · resumes ${clockTime(head.resumeAt, now)}`,
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
export function heldLook(
  task: Task,
  head: Held,
  iteration: LoopIteration,
  now: Date = new Date(),
): { tone: Tone; word: string; ring: RingProps } {
  const config = task.loop_config;
  const used = lasted(iteration);
  const ring = (
    tone: Tone,
    small: string,
    share = 1,
    big: string | number = formatDuration(used),
  ): RingProps => ({ share, tone, big, small, label: `Iteration ${iteration.n}: ${small}` });
  switch (head.kind) {
    case "gated":
      return {
        tone: "warning",
        word: head.backoff
          ? `${head.agentId} hit its usage limit`
          : `Waiting for the ${head.label.toLowerCase()}`,
        ring: { ...ring("warning", "resumes", 1, clockTime(head.resumeAt, now)), glow: "warning" },
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
export function heldReason(
  task: Task,
  head: Held,
  iteration: LoopIteration,
  now: Date = new Date(),
): string {
  if (head.kind === "gated") {
    return `The refused attempt is kept as a WIP commit and runs again at ${clockTime(head.resumeAt, now)}, without counting. The next session never sees the error.`;
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

/** The head card of an iteration at work, or stopped on its question. */
export function workingCard(
  task: Task,
  current: CurrentState & { head: { kind: "live" | "blocked" } },
  checks: LoopCheck[],
  commands: number,
  judged: boolean,
): { tone: Tone; word: string; ring: RingProps | LiveRingSpec; tiles: Tile[]; asking: boolean } {
  const { iteration, head } = current;
  // The round runs the steps, then the checks, in order: the first without a result is running.
  const steps = setupOutcomes(iteration, checks);
  const run = checkOutcomes(iteration, checks).filter((o) => o.check.kind === "Command");
  const stepAt = steps.findIndex((o) => !o.result);
  const checkAt = run.findIndex((o) => !o.result);
  const stepFailed = failedStep(iteration, checks);
  const limitSecs = task.loop_config?.max_build_secs ?? 7200;
  const blocked = head.kind === "blocked";
  const step = head.kind === "live" ? head.step : 0;
  const activity = head.kind === "live" ? head.activity : null;
  const asking = step === 0 && activity?.status === "awaiting_input";
  const doing = activity ? DOING[activity.status] : "Working";
  const tone: Tone = blocked || asking ? "warning" : "accent";
  const ring: RingProps | LiveRingSpec = blocked
    ? {
        share: Math.min(1, lasted(iteration) / limitSecs),
        tone: "warning",
        big: formatDuration(lasted(iteration)),
        small: "stopped",
        label: `Build stopped after ${formatDuration(lasted(iteration))}`,
      }
    : { live: true, building: step === 0, limitSecs, amber: asking };
  const tiles: Tile[] = [
    {
      label: "Build",
      icon: Hammer,
      sub: blocked
        ? `stopped after ${formatDuration(lasted(iteration))}`
        : step > 0
          ? "done"
          : doing,
      since: !blocked && step === 0 ? activity?.since : undefined,
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

/** A markdown text's first line with something on it, its heading or list marks dropped. */
export function plainFirstLine(text: string | null | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? ""
  );
}

/** What a row says where its dots would be, for an iteration whose checks did not run. */
export function sideNote(iteration: LoopIteration): string | null {
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
