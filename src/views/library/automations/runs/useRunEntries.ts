import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useActiveSessionsQuery, useLoadAcpSessionMutation } from "@/services/execution.service";
import { useAutomationRunsQuery } from "@/services/automation.service";
import { useSessionActivityStore } from "@/store/sessionActivityStore";
import { useNavigate } from "@/store/navigationStore";
import { entriesOf, type RunEntry } from "./runs";
import type { ConnectionKey } from "@/types/bindings";

/**
 * Every run this project's automations have had, and what can be done about each.
 *
 * One query behind both views. The row's disclosure filters this by automation id and the panel
 * groups the whole of it by day, so the two cannot disagree about a run they both show.
 */
export function useRunEntries(projectId: number) {
  const { data: runs } = useAutomationRunsQuery(projectId);
  const { data: sessions } = useActiveSessionsQuery(projectId);
  const activity = useSessionActivityStore((state) => state.sessions);

  return entriesOf(runs ?? [], sessions ?? [], activity);
}

/**
 * One clock for every duration on the page, ticking every half minute.
 *
 * Read during render, so it cannot be `Date.now()` at the point of use: a running automation shows
 * "running for 2m", which has to move on its own, and every card reading its own clock would have
 * them disagree by a second and re-render at different times.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Open the session a run happened in.
 *
 * Live, this is navigation. Closed by the idle sweep, it is a `session/load` from the ids the run
 * row kept, which lands in the same place: a session with its transcript, that can be carried on.
 * The wait is the only difference the user sees, which is why the button says so while it runs.
 */
export function useOpenRun(projectId: number, connection: ConnectionKey) {
  const navigate = useNavigate();
  const load = useLoadAcpSessionMutation();
  const [loading, setLoading] = useState<string | null>(null);

  async function open(entry: RunEntry) {
    if (entry.action === "open" && entry.live) {
      navigate({ sessionId: entry.live.session_id });
      return;
    }
    if (entry.action !== "load") return;
    const { agent_id, agent_session_id, cwd, automation_name } = entry.run;
    if (!agent_id || !agent_session_id || !cwd) return;

    setLoading(entry.run.id);
    try {
      const sessionId = await load.mutateAsync({
        agentId: agent_id,
        acpSessionId: agent_session_id,
        cwd,
        connection,
        sessionName: automation_name,
        projectId,
      });
      navigate({ sessionId });
    } catch {
      // The mutation already toasts what went wrong; this is the part it cannot know.
      toast.error(`Could not reopen “${automation_name}”`, {
        description: "Its agent no longer has this conversation.",
      });
    } finally {
      setLoading(null);
    }
  }

  return { open, loading };
}
