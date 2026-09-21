import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";

/**
 * Which automations are running right now, and in which session.
 *
 * In memory on purpose, and not as a shortcut. The automations themselves live in a committed
 * `.maestro/automations.json`, where a run belonging to one machine has no business being; and the
 * session a run points at is itself in memory and dies with the app. A persisted id would outlive
 * the thing it names and have to be swept at startup to stop it lying.
 *
 * What it buys: the row can say "running", Stop has something to stop, and pressing Run now twice
 * cannot put two agents in the same workspace.
 */
interface Run {
  sessionId: string;
  /**
   * Whether the session has been seen in the active-session list yet.
   *
   * A run is only finished once it has been seen and then disappears. Without that, the list
   * fetched a moment before the spawn — which cannot contain the new session — would end the run
   * the instant it started.
   */
  seen: boolean;
}

interface AutomationRunState {
  /** Automation id → its live run. */
  runs: Record<string, Run>;
  /**
   * Automation id → when the clock last fired it, as epoch milliseconds.
   *
   * The floor the next occurrence is computed from, so one tick cannot fire the same occurrence
   * twice. In memory with everything else: persisting it would mean a file write per run, and the
   * question it answers ("has this already gone off since Maestro opened?") only has a meaning
   * inside one session anyway, because a closed Maestro runs nothing.
   */
  lastFiredAt: Record<string, number>;
  /** Claim an occurrence. Called before the spawn, so a slow spawn cannot be fired again. */
  markFired: (automationId: string, at: number) => void;
  start: (automationId: string, sessionId: string) => void;
  /** Drop a run without waiting for the session list, for a spawn that failed outright. */
  finish: (automationId: string) => void;
  /**
   * Reconcile against the sessions that actually exist.
   *
   * One call rather than a per-run subscription: session end, a crash, and the user closing the
   * session from the Agents tab all look the same from here, which is the point.
   */
  observe: (activeSessionIds: string[]) => void;
}

export const useAutomationRunStore = create<AutomationRunState>()(
  immer((set) => ({
    runs: {},
    lastFiredAt: {},
    markFired: (automationId, at) =>
      set((state) => {
        state.lastFiredAt[automationId] = at;
      }),
    start: (automationId, sessionId) =>
      set((state) => {
        state.runs[automationId] = { sessionId, seen: false };
      }),
    finish: (automationId) =>
      set((state) => {
        delete state.runs[automationId];
      }),
    observe: (activeSessionIds) =>
      set((state) => {
        for (const [id, run] of Object.entries(state.runs)) {
          const alive = activeSessionIds.includes(run.sessionId);
          if (alive) run.seen = true;
          else if (run.seen) delete state.runs[id];
        }
      }),
  })),
);

/** The live session's id for one automation, or undefined when it is not running. */
export const useAutomationRun = (automationId: string): string | undefined =>
  useAutomationRunStore((state) => state.runs[automationId]?.sessionId);

export const useAutomationRunActions = () =>
  useAutomationRunStore(
    useShallow((state) => ({
      start: state.start,
      finish: state.finish,
      observe: state.observe,
    })),
  );
