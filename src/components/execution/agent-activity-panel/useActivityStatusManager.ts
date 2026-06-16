import { useEffect } from "react";
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
  const { setActivity, removeActivity } = useSessionActivityActions();

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
      } else {
        //setActivity(sessionKey, "idle");
      }
    } else {
      //setActivity(sessionKey, "idle");
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
}
