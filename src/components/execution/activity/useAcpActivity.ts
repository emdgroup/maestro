import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { drainAcpReplay } from "@/services/execution.service";
import { loadSavedCanvases } from "@/services/canvas.service";
import { useSelectedProject } from "@/store/projectStore";
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
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;

  // Stream events can arrive at token rate; dispatching each one individually
  // forces a reducer + render pass per event and saturates the renderer thread
  // (frozen spinners, laggy typing). Buffer them and flush at most every 50ms —
  // React batches all dispatches in one flush into a single render.
  const pendingRef = useRef<Array<{ action: ActivityAction; raw?: Record<string, unknown> }>>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enqueue = useCallback(
    (action: ActivityAction, raw?: Record<string, unknown>) => {
      pendingRef.current.push({ action, raw });
      if (flushTimerRef.current != null) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const batch = pendingRef.current;
        pendingRef.current = [];
        for (const { action: a, raw: r } of batch) {
          dispatch(a);
          if (r) sessionUpdateRef?.current?.(r);
        }
      }, 50);
    },
    [sessionUpdateRef],
  );

  const tryRestoreCanvases = useCallback(() => {
    if (projectId == null || logId == null) return;
    loadSavedCanvases(projectId, logId)
      .then((surfaces) => {
        if (surfaces.length > 0) dispatch({ type: "restore_canvases", surfaces });
      })
      .catch(console.error);
  }, [projectId, logId]);

  useEffect(() => {
    if (logId == null) return;

    const unlisten = Promise.all([
      listen<unknown>(`acp://session-update/${logId}`, (event) => {
        const raw = event.payload as Record<string, unknown>;
        const payload = raw as unknown as SessionUpdatePayload;
        enqueue({ type: "event", payload, raw }, raw);
      }),
      listen<null>(`acp://session-ended/${logId}`, () => {
        enqueue({ type: "session_ended" });
      }),
      listen<string>(`acp://turn-ended/${logId}`, (e) => {
        const stopReason = e.payload;
        if (stopReason === "error" || stopReason === "auth_required") {
          enqueue({
            type: "append_error",
            stopReason,
            message:
              stopReason === "auth_required"
                ? "Authentication required — log in to continue."
                : "Agent encountered an error and could not respond.",
          });
        }
        enqueue({ type: "turn_ended" });
      }),
      listen<null>(`acp://replay-drained/${logId}`, () => {
        enqueue({ type: "turn_ended" });
        enqueue({ type: "set_initialized" });
        tryRestoreCanvases();
      }),
      listen<null>(`acp://spawn-ok/${logId}`, () => {
        enqueue({ type: "turn_ended" });
        enqueue({ type: "set_initialized" });
        tryRestoreCanvases();
      }),
      listen<string>(`acp://session-error/${logId}`, (event) => {
        if (!event.payload.includes("session/load failed")) {
          toast.error(`Agent failed to start: ${event.payload}`);
        }
        enqueue({ type: "session_ended" });
        enqueue({ type: "set_initialized" });
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
      // Drop events buffered for the previous session so they can't leak into
      // the next session's reducer state.
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [logId, enqueue, tryRestoreCanvases]);

  return [state, dispatch];
}
