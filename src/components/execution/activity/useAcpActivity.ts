import React, { useEffect, useReducer } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { drainAcpReplay } from "@/services/execution.service";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type { SessionUpdatePayload, ActivityState } from "./types";
import { activityReducer } from "./activityReducer";
import type { ActivityAction } from "./activityReducer";

// Re-export so existing callers (canvas.test.ts, useMessageSender.ts) keep working
export { activityReducer } from "./activityReducer";
export type { ActivityAction } from "./activityReducer";

export function useAcpActivity(
  logId: number | null,
  sessionUpdateRef?: React.RefObject<((payload: Record<string, unknown>) => void) | undefined>,
): [ActivityState, React.Dispatch<ActivityAction>] {
  const [state, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

  useEffect(() => {
    if (logId == null) return;

    const unlisten = Promise.all([
      listen<unknown>(`acp://session-update/${logId}`, (event) => {
        const raw = event.payload as Record<string, unknown>;
        const payload = raw as unknown as SessionUpdatePayload;
        dispatch({ type: "event", payload, raw });
        sessionUpdateRef?.current?.(raw);
      }),
      listen<null>(`acp://session-ended/${logId}`, () => {
        dispatch({ type: "session_ended" });
      }),
      listen<string>(`acp://turn-ended/${logId}`, () => {
        dispatch({ type: "turn_ended" });
      }),
      listen<null>(`acp://replay-drained/${logId}`, () => {
        dispatch({ type: "turn_ended" });
        dispatch({ type: "set_initialized" });
      }),
      listen<null>(`acp://spawn-ok/${logId}`, () => {
        dispatch({ type: "turn_ended" });
        dispatch({ type: "set_initialized" });
      }),
      listen<string>(`acp://session-error/${logId}`, (event) => {
        if (!event.payload.includes("session/load failed")) {
          toast.error(`Agent failed to start: ${event.payload}`);
        }
        dispatch({ type: "session_ended" });
        dispatch({ type: "set_initialized" });
      }),
    ])
      .then((listeners) => {
        drainAcpReplay(logId).catch(console.error);
        return listeners;
      })
      .catch(console.error);

    return () => {
      unlisten.then((fns) => {
        if (fns) for (const fn of fns) fn();
      });
    };
  }, [logId, sessionUpdateRef]);

  return [state, dispatch];
}
