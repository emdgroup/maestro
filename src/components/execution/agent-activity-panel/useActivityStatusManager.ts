import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import type { ActivityState } from "../activity/types";

function toolKindCategory(kind: string): string {
  if (/edit|write_file|edit_file|create_file|delete/.test(kind)) return "Editing";
  if (/read|read_file/.test(kind)) return "Reading";
  if (/execute|bash|shell|run_terminal/.test(kind)) return "Running command";
  if (/search|grep|glob/.test(kind)) return "Searching";
  if (/fetch/.test(kind)) return "Fetching";
  if (/think/.test(kind)) return "Thinking";
  if (/switch_mode/.test(kind)) return "Switching mode";
  return "Tool use";
}

export function useActivityStatusManager(
  sessionKey: number,
  liveState: Pick<ActivityState, "items" | "isInitializing" | "isTurnActive" | "sessionEnded">,
): void {
  const { setActivity, removeActivity, resetIfStale } = useSessionActivityActions();

  useEffect(() => {
    setActivity(sessionKey, "spawning");
    return () => {
      removeActivity(sessionKey);
    };
  }, [sessionKey, setActivity, removeActivity]);

  useEffect(() => {
    if (liveState.isInitializing) return;
    if (liveState.sessionEnded) {
      removeActivity(sessionKey);
      return;
    }
    const { items } = liveState;
    const lastItem = items[items.length - 1];

    if (!lastItem || !liveState.isTurnActive) {
      setActivity(sessionKey, "idle");
      return;
    }

    if (
      (lastItem.type === "thinking" || lastItem.type === "message") &&
      lastItem.item.isStreaming
    ) {
      setActivity(sessionKey, "thinking");
    } else if (lastItem.type === "toolCall") {
      const tc = lastItem.item;
      if (tc.status === "pending" || tc.status === "in_progress") {
        if (/think/.test(tc.kind)) {
          setActivity(sessionKey, "thinking");
        } else {
          setActivity(sessionKey, "acting", toolKindCategory(tc.kind));
        }
      }
    }
  }, [
    liveState.items,
    liveState.isInitializing,
    liveState.isTurnActive,
    liveState.sessionEnded,
    sessionKey,
    setActivity,
    removeActivity,
  ]);

  // Stale connection detector: if a turn is active but no new events arrive for 45s,
  // mark the session stale so the UI can show a warning and offer a force-end action.
  // heartbeatCount resets this timer on every server ping so long-running operations
  // (no items emitted for >45s) don't trigger a false-positive "Connection lost".
  const itemsLength = liveState.items.length;
  const [heartbeatCount, setHeartbeatCount] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("acp://heartbeat", () => {
      setHeartbeatCount((n) => n + 1);
      resetIfStale(sessionKey);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [sessionKey, resetIfStale]);

  useEffect(() => {
    if (!liveState.isTurnActive || liveState.sessionEnded || liveState.isInitializing) return;
    const id = setTimeout(() => setActivity(sessionKey, "stale"), 45_000);
    return () => clearTimeout(id);
  }, [
    liveState.isTurnActive,
    liveState.sessionEnded,
    liveState.isInitializing,
    itemsLength,
    heartbeatCount,
    sessionKey,
    setActivity,
  ]);
}
