import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAutomationsQuery } from "@/services/automation.service";
import { useAutomationRunStore } from "@/store/automationRunStore";
import { useNavigationStore } from "@/store/navigationStore";
import { isDue } from "@/views/library/automations/schedule";
import { useRunAutomation } from "./useRunAutomation";
import type { Automation, ConnectionKey } from "@/types/bindings";

const TICK_MS = 60_000;

/**
 * The clock. Fires every scheduled automation whose time has come round.
 *
 * Mounted in `App`, not in the Library view: an automation that only ran while its own tab was on
 * screen would be a scheduler nobody can leave. It still only runs while Maestro is open on this
 * project, which is the whole of what an automation promises.
 *
 * Nothing is caught up. An occurrence that passed while the app was closed is gone, not queued:
 * the floor for a first run is when this hook mounted, so opening Maestro at 09:05 does not set
 * off everything scheduled for 09:00.
 */
export function useAutomationTick(
  /** Null on the project picker, where there is nothing to schedule. */
  projectId: number | null,
  projectPath: string | null,
  connection: ConnectionKey,
) {
  const { data } = useAutomationsQuery(projectId);
  const run = useRunAutomation(projectId ?? 0, projectPath ?? "", connection);

  // Read through refs inside the interval, so a change to either does not restart the clock and
  // reset the phase of the tick. Mirrored from an effect rather than assigned during render:
  // both are only read from the timer, which runs after commit.
  const automations = useRef<Automation[]>([]);
  const runRef = useRef(run);
  useEffect(() => {
    automations.current = data?.automations ?? [];
    runRef.current = run;
  });

  useEffect(() => {
    if (projectId == null) return;
    // Occurrences before this are the previous session's business.
    const mountedAt = Date.now();

    function tick() {
      const now = Date.now();
      const { runs, lastFiredAt, markFired } = useAutomationRunStore.getState();

      for (const automation of automations.current) {
        // Still going from last time: skipping is what keeps a slow daily run from stacking up
        // agents in the same workspace.
        if (runs[automation.id]) continue;
        if (!isDue(automation, lastFiredAt[automation.id] ?? mountedAt, now)) continue;

        markFired(automation.id, now);
        void runRef.current(automation);

        // An agent starting on its own is worth saying out loud, even on a tab where the row is
        // not visible. The session id is only known once the spawn returns, so the action reads
        // the run when it is clicked rather than closing over it.
        toast.info(`“${automation.name}” started`, {
          description: "Started by its schedule.",
          action: {
            label: "Open session",
            onClick: () => {
              const sessionId = useAutomationRunStore.getState().runs[automation.id]?.sessionId;
              if (sessionId !== undefined)
                useNavigationStore.getState().navigate({ sessionId: sessionId });
            },
          },
        });
      }
    }

    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [projectId]);
}
