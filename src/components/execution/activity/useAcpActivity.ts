import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { drainAcpReplay } from "@/services/execution.service";
import { loadSavedCanvases, saveCanvasSurface } from "@/services/canvas.service";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type { SessionUpdatePayload, ActivityState, CanvasSurface } from "./types";
import { activityReducer } from "./activityReducer";
import type { ActivityAction } from "./activityReducer";

// Re-export so existing callers (canvas.test.ts, useMessageSender.ts) keep working
export { activityReducer } from "./activityReducer";
export type { ActivityAction } from "./activityReducer";

/**
 * Sessions already asked to listen to their canvases, so that a remount does not ask twice.
 *
 * Module-level rather than a ref, because a ref is exactly what a remount discards — and the
 * panel remounts on every session switch, and on every hot reload during development. Cleared when
 * a session ends, so reopening one legitimately asks again.
 */
const canvasTriggered = new Set<string>();

export function useAcpActivity(
  sessionId: string | null,
  sessionUpdateRef?: React.RefObject<((payload: Record<string, unknown>) => void) | undefined>,
  /**
   * Called with the ids of surfaces restored from disk. A restored canvas has live controls and
   * nothing listening — the agent is idle and cannot open a `canvas_await` outside a turn — so the
   * panel answers this by prompting it once. A ref for the same reason as `sessionUpdateRef`: the
   * listener effect below must not re-subscribe because a callback identity changed.
   */
  canvasesRestoredRef?: React.RefObject<((surfaceIds: string[]) => void) | undefined>,
): [ActivityState, React.Dispatch<ActivityAction>] {
  const [state, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY_STATE);

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

  // What has been written is tracked by object identity, which is only meaningful within one
  // session — so the record is tied to the `sessionId` it was built for rather than to this hook
  // instance. Today the panel remounts per session and the distinction never shows; if it ever
  // stops doing that, the failure is silent, and a surface that was never written looks saved
  // until a restart loses it.
  const savedRef = useRef<{ sessionId: string | null; surfaces: Map<string, CanvasSurface> }>({
    sessionId: null,
    surfaces: new Map(),
  });
  const savedSurfaces = useCallback(
    (forSessionId: string) => {
      if (savedRef.current.sessionId !== forSessionId) {
        savedRef.current = { sessionId: forSessionId, surfaces: new Map() };
      }
      return savedRef.current.surfaces;
    },
    // Reads and writes a ref only; kept stable so the effects below do not re-run.
    [],
  );

  const tryRestoreCanvases = useCallback(() => {
    if (sessionId == null) return;
    loadSavedCanvases(sessionId)
      .then((surfaces) => {
        if (surfaces.length === 0) return;
        // They came off disk, so they are already written. Without this the save below would copy
        // every restored surface straight back, which on a remote session is a round trip each.
        const saved = savedSurfaces(sessionId);
        for (const surface of surfaces) saved.set(surface.surfaceId, surface);
        dispatch({ type: "restore_canvases", surfaces });
        if (canvasTriggered.has(sessionId)) return;
        canvasTriggered.add(sessionId);
        canvasesRestoredRef?.current?.(surfaces.map((surface) => surface.surfaceId));
      })
      .catch(console.error);
  }, [sessionId, canvasesRestoredRef, savedSurfaces]);

  useEffect(() => {
    if (sessionId == null) return;

    const unlisten = Promise.all([
      listen<unknown>(`acp://session-update/${sessionId}`, (event) => {
        const raw = event.payload as Record<string, unknown>;
        const payload = raw as unknown as SessionUpdatePayload;
        enqueue({ type: "event", payload, raw }, raw);
      }),
      listen<null>(`acp://session-ended/${sessionId}`, () => {
        // Reopening this session will restore its canvases into an agent that is listening to
        // nothing again, so the ask is owed a second time.
        canvasTriggered.delete(sessionId);
        enqueue({ type: "session_ended" });
      }),
      listen<string>(`acp://turn-ended/${sessionId}`, (e) => {
        const stopReason = e.payload;
        if (stopReason === "error" || stopReason === "auth_required") {
          enqueue({
            type: "append_error",
            stopReason,
            message:
              stopReason === "auth_required"
                ? "Authentication required. Log in to continue."
                : "Agent encountered an error and could not respond.",
          });
        }
        enqueue({ type: "turn_ended" });
      }),
      listen<null>(`acp://replay-drained/${sessionId}`, () => {
        enqueue({ type: "turn_ended" });
        enqueue({ type: "set_initialized" });
        tryRestoreCanvases();
      }),
      listen<null>(`acp://spawn-ok/${sessionId}`, () => {
        enqueue({ type: "turn_ended" });
        enqueue({ type: "set_initialized" });
        tryRestoreCanvases();
      }),
      listen<string>(`acp://session-error/${sessionId}`, (event) => {
        // A failed restore is not "the agent failed to start", and reopening a project whose
        // worktrees have been pruned produces one per stale session — which is why it gets no
        // toast. But it still ends the session, and that takes the compose bar with it, so
        // saying nothing left a session the user could read and not type into with no clue
        // why. It goes in the transcript they are already looking at instead.
        if (event.payload.includes("session/load failed")) {
          enqueue({
            type: "append_error",
            stopReason: "error",
            message: `This session could not be restored and has been closed. ${event.payload}`,
          });
        } else {
          toast.error(`Agent failed to start: ${event.payload}`);
        }
        enqueue({ type: "session_ended" });
        enqueue({ type: "set_initialized" });
      }),
    ])
      .then((listeners) => {
        drainAcpReplay(sessionId).catch(console.error);
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
  }, [sessionId, enqueue, tryRestoreCanvases]);

  // Canvases are written to disk while the agent is idle, so a restarted app gets them back.
  //
  // Fences used to make this free: they were part of the transcript, so a replayed session
  // rebuilt every surface from it. Tool calls are not — nothing replays them — so the surface
  // only exists in this reducer until it is saved.
  //
  // The trigger is the turn ending rather than the surface changing, because the write now goes
  // over the session's connection: `canvas_update` merges in place, and a dashboard filling in
  // from tool calls revises the same surface many times, which on an SSH session is a round trip
  // each. A restored surface, an imported one and anything drawn after the turn are all covered
  // too — each of those lands while this is already idle. The cost is that the app being killed
  // mid-turn loses whatever that turn drew.
  const isIdle = !state.isTurnActive || state.sessionEnded;
  useEffect(() => {
    if (sessionId == null || !isIdle || state.canvasMap.size === 0) return;
    const saved = savedSurfaces(sessionId);
    for (const [surfaceId, surface] of state.canvasMap) {
      if (saved.get(surfaceId) === surface) continue;
      saved.set(surfaceId, surface);
      saveCanvasSurface(sessionId, surface).catch((e) => {
        console.warn(`[canvas] could not save ${surfaceId}`, e);
      });
    }
  }, [state.canvasMap, isIdle, sessionId, savedSurfaces]);

  return [state, dispatch];
}
