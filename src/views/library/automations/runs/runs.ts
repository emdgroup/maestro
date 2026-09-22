/**
 * What a run is, read off the row plus whatever the session it names is doing now.
 *
 * Running, Succeeded and Failed are all the database knows. Whether a run is stuck on a question
 * is live session state, held beside the request in the daemon and handed back on attach, so the
 * fourth state below is a join rather than a column.
 */

import type { ActiveSessionInfo, AutomationRun } from "@/types/bindings";
import type { SessionActivityInfo } from "@/store/sessionActivityStore";

export type RunState = "running" | "awaiting" | "succeeded" | "failed";

export interface RunEntry {
  run: AutomationRun;
  state: RunState;
  /** The live session this run is happening in, when there still is one. */
  live: ActiveSessionInfo | undefined;
  /** How to get to it, or why there is no way. */
  action: "open" | "load" | "none";
}

export function runState(run: AutomationRun, activity: SessionActivityInfo | undefined): RunState {
  if (run.status !== "running") return run.status;
  return activity?.status === "awaiting_input" ? "awaiting" : "running";
}

/**
 * Which of the three things the button can be.
 *
 * `load` is not a lesser version of `open`: it ends in the same place, a live session with its
 * transcript, and only takes longer. `none` is for the run that cannot get there at all, either
 * because it never had a session or because its agent cannot reload one, and it draws no button
 * rather than one that fails.
 */
export function runAction(
  run: AutomationRun,
  live: ActiveSessionInfo | undefined,
): RunEntry["action"] {
  if (live) return "open";
  // `can_reload` is the agent's answer, recorded by the daemon when the session was made: whether
  // an agent answers `session/load` cannot be asked once its session is gone, and discovery does
  // not carry it. A run from before that was recorded has it absent and gets no button.
  if (run.agent_session_id && run.agent_id && run.cwd && run.can_reload) return "load";
  return "none";
}

export function entriesOf(
  runs: AutomationRun[],
  sessions: ActiveSessionInfo[],
  activity: Record<string, SessionActivityInfo>,
): RunEntry[] {
  return runs.map((run) => {
    const live = sessions.find((session) => session.session_id === run.session_id);
    return {
      run,
      state: runState(run, run.session_id ? activity[run.session_id] : undefined),
      live,
      action: runAction(run, live),
    };
  });
}

/** How long a run took, or has been going. */
export function runDuration(run: AutomationRun, now: number): string {
  const started = new Date(run.started_at).getTime();
  const ended = run.finished_at ? new Date(run.finished_at).getTime() : now;
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The heading a run is filed under. Today, Yesterday, then the date. */
export function dayOf(run: AutomationRun, now: Date): string {
  const started = new Date(run.started_at);
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(started).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return started.toLocaleDateString([], { day: "numeric", month: "long" });
}

/** Runs grouped into days, newest first, keeping the order they came in. */
export function byDay(entries: RunEntry[], now: Date): Array<[string, RunEntry[]]> {
  const days = new Map<string, RunEntry[]>();
  for (const entry of entries) {
    const day = dayOf(entry.run, now);
    const existing = days.get(day);
    if (existing) existing.push(entry);
    else days.set(day, [entry]);
  }
  return [...days.entries()];
}
