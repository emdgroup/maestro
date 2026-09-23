import { useEffect, useMemo, type MutableRefObject } from "react";
import type { ToolCallItem } from "../activity/types";

/**
 * Continues a turn that was cut off by something other than the user — a dropped connection, a
 * dead server, a session reopened from history mid-tool-call — where unfinished tool calls are
 * evidence of an abandoned turn worth picking back up.
 *
 * `"interrupted"` alone is not that evidence: `interruptStalledToolCalls` marks every pending call
 * interrupted on any turn or session end, and a user pressing Stop is exactly that path. The
 * signal has to come from the local user action, so `handleCancel` marks the same ref spent — the
 * stop reason on `acp://turn-ended/{sessionId}` cannot be trusted to say "cancelled".
 *
 * Spent for the rest of the panel's life either way: nothing ever moves a call off `"interrupted"`,
 * so a per-turn flag would fire on the user's next prompt.
 */
export function useAutoResume({
  toolCallMap,
  isInitializing,
  isNewSession,
  taskId,
  autoResumeSpentRef,
  handleSend,
}: {
  toolCallMap: Map<string, ToolCallItem>;
  isInitializing: boolean;
  isNewSession: boolean;
  taskId: number | null;
  autoResumeSpentRef: MutableRefObject<boolean>;
  handleSend: (content: string) => void | Promise<void>;
}): void {
  const hasInterruptedCalls = useMemo(
    () => [...toolCallMap.values()].some((tc) => tc.status === "interrupted"),
    [toolCallMap],
  );
  useEffect(() => {
    if (
      !isInitializing &&
      !isNewSession &&
      hasInterruptedCalls &&
      taskId != null &&
      !autoResumeSpentRef.current
    ) {
      autoResumeSpentRef.current = true;
      handleSend("resume");
    }
  }, [isInitializing, hasInterruptedCalls, isNewSession, taskId, autoResumeSpentRef, handleSend]);
}
