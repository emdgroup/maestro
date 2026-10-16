import type { AgentGateState, LoopCheckState, LoopHalt, Task } from "@/types/bindings";

/** What a card says on its phase line, and how loudly. */
export interface StateLine {
  label: string;
  detail?: string;
  tone: "brand" | "warning" | "muted" | "success" | "destructive" | "amber";
  /** Replaces the card's phase-status ring. */
  ring?: string;
}

/** The pulse the board keeps for "stopped dead, waiting on you". */
export const NEEDS_YOU_RING = "animate-glow-warning border-warning";
export const GATED_RING = "border-dashed border-amber-500/60";

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
