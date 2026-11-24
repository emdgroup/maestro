import type React from "react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UsageState } from "./types";
import {
  getLifecycle,
  setSessionHandler,
  shownRequest,
  subscribeSession,
  updateLifecycle,
  type PendingElicitation,
  type PendingPermission,
  type SessionLifecycle,
} from "./sessionRuntime";

export type { AcpPromptCapabilities } from "./sessionRuntime";

export type AcpSessionLifecycleResult = SessionLifecycle & {
  /** The request shown, when it is a permission. */
  pendingPermission: PendingPermission | null;
  /** The request shown, when it is a question. */
  pendingElicitation: PendingElicitation | null;
  /** Drops an answered request. Returns whether others are still waiting. */
  resolvePendingRequest: (requestId: string) => boolean;
  /** Brings a waiting request forward. */
  showPendingRequest: (requestId: string) => void;
};

/** The session's config, usage and pending requests, held by its runtime like its transcript. */
export function useAcpSessionLifecycle(
  sessionId: string,
  onUsageChangeRef: React.RefObject<((usage: UsageState | null) => void) | undefined>,
): AcpSessionLifecycleResult {
  const subscribe = useCallback((fn: () => void) => subscribeSession(sessionId, fn), [sessionId]);
  const lifecycle = useSyncExternalStore(subscribe, () => getLifecycle(sessionId));

  useEffect(
    () =>
      setSessionHandler(sessionId, "onUsageChange", (usage) => onUsageChangeRef.current?.(usage)),
    [sessionId, onUsageChangeRef],
  );

  const resolvePendingRequest = useCallback(
    (requestId: string) => {
      updateLifecycle(sessionId, (l) => ({
        ...l,
        pendingRequests: l.pendingRequests.filter((r) => r.requestId !== requestId),
        shownRequestId: l.shownRequestId === requestId ? null : l.shownRequestId,
      }));
      return getLifecycle(sessionId).pendingRequests.length > 0;
    },
    [sessionId],
  );
  const showPendingRequest = useCallback(
    (requestId: string) => updateLifecycle(sessionId, (l) => ({ ...l, shownRequestId: requestId })),
    [sessionId],
  );

  const shown = shownRequest(lifecycle);
  return {
    ...lifecycle,
    pendingPermission: shown?.kind === "permission" ? shown : null,
    pendingElicitation: shown?.kind === "elicitation" ? shown : null,
    resolvePendingRequest,
    showPendingRequest,
  };
}
