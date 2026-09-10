/*
  The other side of `AgentStreamContent.render.test.tsx`. That one asserts memoized rows *stop*
  re-rendering; this one asserts the row that should re-render still does, with the real
  `AgentStreamItem` rather than a counter.

  A `memo` boundary that bails out too eagerly does not crash or warn — the row simply stops
  updating, or never appears. Thinking blocks are the sharpest case: under the default `auto`
  visibility they render expanded while streaming and collapse to a "Thought" row when the turn
  ends, so they change shape twice on their own, driven entirely by item identity.
*/
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { activityReducer } from "../activity/activityReducer";
import { groupIntoAgentSections, groupToolCalls } from "../activity/utils";
import { INITIAL_ACTIVITY_STATE } from "../activity/types";
import type { ActivityState, ToolCallItem } from "../activity/types";
import { AgentStreamContent } from "./AgentStreamContent";

vi.mock("@/services/settings.service", () => ({
  useSettings: () => ({ data: { thinking_visibility: "auto", tool_call_visibility: "show" } }),
}));

vi.mock("@/ui/message-scroller", () => ({
  MessageScroller: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerViewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ scrollToEnd: () => {} }),
}));

function thought(state: ActivityState, text: string): ActivityState {
  return activityReducer(state, {
    type: "event",
    payload: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
      messageId: "th-1",
    },
    raw: {},
  });
}

const sectionsOf = (s: ActivityState) => groupIntoAgentSections(groupToolCalls(s.items));
const props = {
  toolCallMap: new Map<string, ToolCallItem>(),
  livePlanToolCallId: null,
  commands: [],
};

describe("thinking blocks render", () => {
  it("shows a streaming thought, and keeps showing it as chunks arrive", () => {
    let state: ActivityState = { ...INITIAL_ACTIVITY_STATE, items: [] };
    state = thought(state, "let me ");

    const { rerender } = render(
      <AgentStreamContent {...props} agentSections={sectionsOf(state)} />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();

    state = thought(state, "consider this");
    rerender(<AgentStreamContent {...props} agentSections={sectionsOf(state)} />);

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText(/let me consider this/)).toBeInTheDocument();
  });

  it("collapses to a Thought row once the turn ends", () => {
    let state: ActivityState = { ...INITIAL_ACTIVITY_STATE, items: [] };
    state = thought(state, "hmm");

    const { rerender } = render(
      <AgentStreamContent {...props} agentSections={sectionsOf(state)} />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();

    state = activityReducer(state, { type: "turn_ended" });
    rerender(<AgentStreamContent {...props} agentSections={sectionsOf(state)} />);

    expect(screen.getByText(/Thought/)).toBeInTheDocument();
  });
});
