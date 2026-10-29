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
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
