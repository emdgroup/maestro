import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { useAutoResume } from "./useAutoResume";
import type { ToolCallItem } from "../activity/types";

function interruptedCall(id: string): ToolCallItem {
  return {
    toolCallId: id,
    title: "read file",
    kind: "read",
    status: "interrupted",
    content: [],
    locations: [],
  };
}

function setup(autoResumeSpent: boolean, calls: ToolCallItem[] = [interruptedCall("t1")]) {
  const handleSend = vi.fn();
  const autoResumeSpentRef = { current: autoResumeSpent };
  const view = renderHook(
    ({ toolCallMap }: { toolCallMap: Map<string, ToolCallItem> }) =>
      useAutoResume({
        toolCallMap,
        isInitializing: false,
        isNewSession: false,
        taskId: 7,
        autoResumeSpentRef,
        handleSend,
      }),
    { initialProps: { toolCallMap: new Map(calls.map((c) => [c.toolCallId, c])) } },
  );
  return { ...view, handleSend };
}

describe("useAutoResume", () => {
  it("resumes a turn left unfinished by something other than the user", () => {
    const { handleSend } = setup(false);
    expect(handleSend).toHaveBeenCalledTimes(1);
    expect(handleSend).toHaveBeenCalledWith("resume");
  });

  it("stays idle when the user pressed Stop", () => {
    // `handleCancel` marks the ref spent before the cancel goes out, so the interrupted calls the
    // resulting turn end produces are not read as an abandoned turn.
    const { handleSend } = setup(true);
    expect(handleSend).not.toHaveBeenCalled();
  });

  it("resumes at most once per mount", () => {
    const { handleSend, rerender } = setup(false);
    rerender({
      toolCallMap: new Map(
        [interruptedCall("t1"), interruptedCall("t2")].map((c) => [c.toolCallId, c]),
      ),
    });
    expect(handleSend).toHaveBeenCalledTimes(1);
  });
});
