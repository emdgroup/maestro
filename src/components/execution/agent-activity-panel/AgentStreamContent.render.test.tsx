/*
  How many transcript rows re-render when one streaming chunk arrives?

  The answer should be O(1) — a chunk extends the text of exactly one message, and nothing else
  in the session changed. What makes it O(N) instead is prop identity: `activityReducer` keeps
  every unchanged `ActivityItem` object, but each grouping pass downstream can allocate fresh
  wrappers around them, and a component whose props are new objects cannot bail out.

  So this measures render counts, not wall time. happy-dom is not a real renderer and its
  timings are noise; a render count is deterministic, survives CI, and is the exact property.
  `AgentStreamItem` is mocked down to a counter, which also keeps markdown and syntax
  highlighting out of the measurement — the memo boundaries under test live in
  `AgentStreamContent`, not in the mocked module, so mocking does not remove them.

  The recorded keys are asserted alongside the count: a grouping change that altered *what* is
  rendered would show up here as a different key list rather than a different number.
*/
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityReducer } from "../activity/activityReducer";
import { groupIntoAgentSections, groupToolCalls } from "../activity/utils";
import { INITIAL_ACTIVITY_STATE } from "../activity/types";
import type { ActivityItem, ActivityState, ToolCallItem } from "../activity/types";
import { AgentStreamContent } from "./AgentStreamContent";

const { renderedKeys } = vi.hoisted(() => ({ renderedKeys: [] as string[] }));

/*
  The key logic is duplicated rather than imported: a `vi.mock` factory is hoisted above this
  file's imports, so it cannot close over `getItemKey`. Duplicating it is also what lets the
  second test compare rendered output before and after a chunk without trusting the module it
  is measuring.
*/
vi.mock("./AgentStreamItem", () => ({
  AgentStreamItem: ({ gi }: { gi: import("../activity/utils").GroupedDisplayItem }) => {
    if (gi.type === "toolGroup") renderedKeys.push(`tg-${gi.items[0].toolCallId}`);
    else if (gi.item.type === "toolCall") renderedKeys.push(gi.item.item.toolCallId);
    else if (gi.item.type === "canvas") renderedKeys.push(gi.item.item.surfaceId);
    else renderedKeys.push(gi.item.item.id);
    return <div data-testid="stream-item" />;
  },
}));

vi.mock("@/services/settings.service", () => ({
  useSettings: () => ({ data: undefined }),
}));

/*
  The scroller is a DOM-measuring primitive with nothing to say about render counts, and
  `AgentStreamContent` calls `useMessageScroller` above its own provider, so it would need one
  from a test wrapper anyway. Plain elements keep both problems out of the measurement.
*/
vi.mock("@/ui/message-scroller", () => ({
  MessageScroller: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerViewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MessageScrollerItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ scrollToEnd: () => {} }),
}));

/** One turn: the user asks, the agent thinks, reads two files, then answers. */
function turn(n: number, isStreaming: boolean): ActivityItem[] {
  return [
    { type: "userMessage", item: { id: `u-${n}`, content: `ask ${n}`, sentAt: n } },
    { type: "thinking", item: { id: `t-${n}`, text: `thinking ${n}`, isStreaming: false } },
    ...(["a", "b"] as const).map((suffix): ActivityItem => ({
      type: "toolCall",
      item: {
        toolCallId: `tc-${n}${suffix}`,
        title: `read ${n}${suffix}`,
        kind: "read",
        status: "completed",
        content: [],
        locations: [],
      },
    })),
    {
      type: "message",
      item: { id: `m-${n}`, text: `answer ${n}`, isStreaming, messageId: `msg-${n}` },
    },
  ];
}

/*
  Big enough that "one row" and "every row" cannot be confused — 180 against 1 — and small
  enough to mount twice inside vitest's default timeout when the whole suite runs in parallel.
  At 200 turns the equivalence test below spent ~5.8s on its two mounts and timed out on a
  loaded machine; the property under test does not care about the exact figure.
*/
const TURNS = 60;
const LAST = TURNS - 1;

/** A session of `TURNS` completed turns whose final message is still streaming. */
function buildState(): ActivityState {
  const items = Array.from({ length: TURNS }, (_, n) => turn(n, n === LAST)).flat();
  return { ...INITIAL_ACTIVITY_STATE, items };
}

/** What `AgentActivityPanel` derives from state before handing it to the stream. */
function sectionsOf(state: ActivityState) {
  return groupIntoAgentSections(groupToolCalls(state.items));
}

function appendChunk(state: ActivityState): ActivityState {
  return activityReducer(state, {
    type: "event",
    payload: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " more" },
      messageId: `msg-${LAST}`,
    },
    raw: {},
  });
}

const streamProps = {
  toolCallMap: new Map<string, ToolCallItem>(),
  livePlanToolCallId: null,
  commands: [],
};

describe("AgentStreamContent re-render cost", () => {
  beforeEach(() => {
    renderedKeys.length = 0;
  });

  it("preserves item identity across a chunk, which everything below relies on", () => {
    const before = buildState();
    const after = appendChunk(before);

    expect(after.items).not.toBe(before.items);
    expect(after.items).toHaveLength(before.items.length);
    for (let i = 0; i < after.items.length - 1; i++) {
      expect(after.items[i]).toBe(before.items[i]);
    }
    expect(after.items[after.items.length - 1]).not.toBe(before.items[before.items.length - 1]);
  });

  it("re-renders a bounded number of rows when one chunk arrives", () => {
    const before = buildState();
    const after = appendChunk(before);

    const { rerender } = render(
      <AgentStreamContent {...streamProps} agentSections={sectionsOf(before)} />,
    );

    // Three rows per turn: the thinking block, the two-call tool group, and the message. The
    // user message opens a standalone section rendered by `ActivityUserMessage` instead.
    expect(renderedKeys).toHaveLength(TURNS * 3);
    expect(renderedKeys.slice(0, 3)).toEqual(["t-0", "tg-tc-0a", "m-0"]);

    renderedKeys.length = 0;
    rerender(<AgentStreamContent {...streamProps} agentSections={sectionsOf(after)} />);

    // The number this test exists to move: it was TURNS * 3 — every row in the session, for a
    // chunk that changed one of them. O(1) now, and independent of TURNS.
    expect(renderedKeys).toEqual([`m-${LAST}`]);
  });

  /*
    Two fresh mounts, not a rerender: a mount renders everything regardless of memoization, so
    this compares what the grouping *produces* rather than what React chose to skip. It is the
    guard that a change made for identity's sake did not change the output.
  */
  it("renders the same rows in the same order after a chunk", () => {
    const before = buildState();
    const after = appendChunk(before);

    render(<AgentStreamContent {...streamProps} agentSections={sectionsOf(before)} />);
    const beforeKeys = [...renderedKeys];

    cleanup();
    renderedKeys.length = 0;
    render(<AgentStreamContent {...streamProps} agentSections={sectionsOf(after)} />);

    expect(renderedKeys).toEqual(beforeKeys);
  });
});
