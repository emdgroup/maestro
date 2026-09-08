import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PlanReviewCard, PendingPlanCard } from "./PlanReviewCard";
import { useAnnotationStore } from "@/store/annotationStore";
import type { ToolCallItem } from "./types";

const SESSION = 3;
const TITLE = "Move plan approval back into the stream";

function planCall(status: ToolCallItem["status"]): ToolCallItem {
  return {
    toolCallId: "tc-1",
    title: TITLE,
    kind: "switch_mode",
    status,
    content: [],
    locations: [],
  };
}

const CLAUDE_OPTIONS = [
  { optionId: "default", name: "Accept", kind: "allow_once" },
  { optionId: "acceptEdits", name: "Accept edits", kind: "allow_always" },
  { optionId: "reject", name: "Keep planning", kind: "reject_once" },
];

/** `null` stands for a payload with no `options` at all — a default parameter cannot, since it
 *  would swallow the `undefined` meant to select that case. */
function setup(options: unknown[] | null = CLAUDE_OPTIONS) {
  const onRespond = vi.fn();
  const onOpen = vi.fn();
  render(
    <PendingPlanCard
      title={TITLE}
      sessionKey={SESSION}
      requestId="perm-1"
      payload={
        {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1", kind: "switch_mode", rawInput: { plan: "# Do it" } },
          ...(options ? { options } : {}),
        } as Record<string, unknown>
      }
      onRespond={onRespond}
      onOpen={onOpen}
    />,
  );
  return { onRespond, onOpen };
}

describe("PendingPlanCard", () => {
  beforeEach(() => {
    act(() => useAnnotationStore.getState().clearSession(SESSION));
  });

  it("answers with the agent's own option ids, under the agent's own labels", () => {
    const { onRespond } = setup();

    expect(screen.getByText("Plan ready for review")).toBeTruthy();
    act(() => screen.getByText("Accept").click());
    expect(onRespond).toHaveBeenCalledWith("perm-1", "default");

    act(() => screen.getByText("Keep planning").click());
    expect(onRespond).toHaveBeenLastCalledWith("perm-1", "reject");
  });

  it("offers the extra accepts behind a chevron", () => {
    setup();
    expect(screen.getByLabelText("More accept options")).toBeTruthy();
  });

  it("drops the chevron when the agent offers a single way to accept", () => {
    setup([
      { optionId: "proceed", name: "Go ahead", kind: "allow_once" },
      { optionId: "stop", name: "Not yet", kind: "reject_once" },
    ]);
    expect(screen.getByText("Go ahead")).toBeTruthy();
    expect(screen.queryByLabelText("More accept options")).toBeNull();
  });

  it("falls back to Reject and Allow for a payload carrying no options", () => {
    const { onRespond } = setup(null);

    act(() => screen.getByText("Allow").click());
    expect(onRespond).toHaveBeenCalledWith("perm-1", "allow");

    // Null is what maestro-server maps to the `cancelled` outcome.
    act(() => screen.getByText("Reject").click());
    expect(onRespond).toHaveBeenLastCalledWith("perm-1", null);
  });

  it("opens the plan rather than answering it", () => {
    const { onOpen, onRespond } = setup();
    act(() => screen.getByText("Review plan").click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("counts only this session's plan notes, and says nothing when there are none", () => {
    setup();
    expect(screen.queryByText(/note/)).toBeNull();

    act(() => {
      useAnnotationStore.getState().addAnnotation(SESSION, {
        id: "a1",
        kind: "plan",
        quote: "the thing",
        occurrence: 0,
        text: "why this order?",
      });
    });
    expect(screen.getByText("1 note")).toBeTruthy();

    // A canvas note belongs to another surface and must not inflate the plan's count.
    act(() => {
      useAnnotationStore.getState().addAnnotation(SESSION, {
        id: "a2",
        kind: "canvas",
        surfaceId: "s1",
        surfaceTitle: "Dash",
        componentIds: [],
        text: "not a plan note",
      });
    });
    expect(screen.getByText("1 note")).toBeTruthy();
  });
});

describe("PlanReviewCard", () => {
  it("reports the outcome of a settled plan, and offers nothing to press", () => {
    const { rerender } = render(<PlanReviewCard item={planCall("completed")} />);
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByText("Plan ready for review")).toBeNull();
    expect(screen.queryByText("Keep planning")).toBeNull();

    rerender(<PlanReviewCard item={planCall("error")} />);
    expect(screen.getByText("Rejected")).toBeTruthy();
  });
});
