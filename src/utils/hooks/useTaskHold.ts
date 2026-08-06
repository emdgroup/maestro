import { useEffect } from "react";
import { api } from "@/lib/tauri-utils";

/// Half the backend's `HOLD_TTL`, so a hold survives one missed beat — a slow frame, a renderer
/// the OS paused — without the user's card being taken out from under them.
const HEARTBEAT_MS = 5_000;

/**
 * Keeps the scheduler off a task while the user is working with it.
 *
 * Dragging a card and having it open in the detail modal are facts only the client knows; there is
 * no row the Rust scheduler can read that says a pointer is down. So this is a lease the client
 * renews for as long as the interaction lasts, and the backend expires on its own if the renewals
 * stop — a window closed mid-drag never sends a release, and a task nothing can start is a worse
 * outcome than one started a moment early.
 */
export function useTaskHold(taskId: number | null, active: boolean) {
  useEffect(() => {
    if (!active || taskId === null) return;

    const beat = () => {
      api.holdTask(taskId).catch((err) => console.warn("[hold] failed to hold task:", err));
    };

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);

    return () => {
      clearInterval(timer);
      // Best-effort: the TTL is what actually guarantees the task comes back.
      api.releaseTaskHold(taskId).catch((err) => console.warn("[hold] failed to release:", err));
    };
  }, [taskId, active]);
}
