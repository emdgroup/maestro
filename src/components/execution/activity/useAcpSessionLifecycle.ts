import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UsageState } from "./types";
import {
  getLifecycle,
  setSessionHandler,
  subscribeSession,
  updateLifecycle,
  type PendingElicitation,
  type PendingPermission,
  type SessionLifecycle,
} from "./sessionRuntime";

export type { AcpPromptCapabilities } from "./sessionRuntime";

export type AcpSessionLifecycleResult = SessionLifecycle & {
  setPendingPermission: React.Dispatch<React.SetStateAction<PendingPermission | null>>;
  setPendingElicitation: React.Dispatch<React.SetStateAction<PendingElicitation | null>>;
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

  const setPendingPermission = useCallback(
    (next: React.SetStateAction<PendingPermission | null>) =>
      updateLifecycle(sessionId, (l) => ({
        ...l,
        pendingPermission: typeof next === "function" ? next(l.pendingPermission) : next,
      })),
    [sessionId],
  );
  const setPendingElicitation = useCallback(
    (next: React.SetStateAction<PendingElicitation | null>) =>
      updateLifecycle(sessionId, (l) => ({
        ...l,
        pendingElicitation: typeof next === "function" ? next(l.pendingElicitation) : next,
      })),
    [sessionId],
  );

  return { ...lifecycle, setPendingPermission, setPendingElicitation };
}
