import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActivityState } from "./types";
import type { ActivityAction } from "./activityReducer";
import {
  dispatchActivity,
  getActivity,
  setSessionHandler,
  subscribeSession,
} from "./sessionRuntime";

// Re-export so existing callers (canvas.test.ts, useMessageSender.ts) keep working
export { activityReducer } from "./activityReducer";
export type { ActivityAction } from "./activityReducer";

/** The session's transcript, held by its runtime so it survives this panel unmounting. */
export function useAcpActivity(
  sessionId: string,
  /**
   * Called with the ids of surfaces restored from disk. A ref so the runtime's callback does not
   * have to be re-pointed every time the panel's closure changes.
   */
  canvasesRestoredRef?: React.RefObject<((surfaceIds: string[]) => void) | undefined>,
): [ActivityState, React.Dispatch<ActivityAction>] {
  const subscribe = useCallback((fn: () => void) => subscribeSession(sessionId, fn), [sessionId]);
  const state = useSyncExternalStore(subscribe, () => getActivity(sessionId));
  const dispatch = useCallback(
    (action: ActivityAction) => dispatchActivity(sessionId, action),
    [sessionId],
  );

  useEffect(
    () =>
      setSessionHandler(sessionId, "onCanvasesRestored", (surfaceIds) =>
        canvasesRestoredRef?.current?.(surfaceIds),
      ),
    [sessionId, canvasesRestoredRef],
  );

  return [state, dispatch];
}
