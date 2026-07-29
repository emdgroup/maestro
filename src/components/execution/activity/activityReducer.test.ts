import { describe, expect, it } from "vitest";
import { activityReducer, type ActivityAction } from "./activityReducer";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type {
  ActivityState,
  ActivityItem,
  MessageItem,
  SessionUpdatePayload,
  ThinkingItem,
  ToolCallItem,
  UserMessageItem,
} from "./types";

/**
 * Fresh state per test. The reducer copies every Map it touches, so sharing
 * INITIAL_ACTIVITY_STATE would work today — building a new one keeps a future
 * mutation from leaking between tests instead of failing somewhere unrelated.
 */
function makeState(overrides: Partial<ActivityState> = {}): ActivityState {
  return {
    ...INITIAL_ACTIVITY_STATE,
    items: [],
    toolCallMap: new Map(),
    pendingOrphans: new Map(),
    canvasMap: new Map(),
    terminalBuffers: new Map(),
    ...overrides,
  };
}

function event(payload: SessionUpdatePayload, raw: Record<string, unknown> = {}): ActivityAction {
  return { type: "event", payload, raw };
}

/** `raw` shape that makes extractAgentMeta report a parent tool call. */
function childOf(parentToolCallId: string): Record<string, unknown> {
  return { _meta: { claudeCode: { parentToolUseId: parentToolCallId } } };
}

function toolCall(toolCallId: string, over: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    toolCallId,
    title: toolCallId,
    kind: "execute",
    status: "pending",
    content: [],
    locations: [],
    ...over,
  };
}

function messageItem(text: string, isStreaming: boolean): ActivityItem {
  return { type: "message", item: { id: `m-${text}`, text, isStreaming } satisfies MessageItem };
}

function thinkingItem(text: string, isStreaming: boolean, messageId?: string): ActivityItem {
  return {
    type: "thinking",
    item: { id: `t-${text}`, text, isStreaming, messageId } satisfies ThinkingItem,
  };
}

const lastItem = (state: ActivityState) => state.items[state.items.length - 1];
const toolCallItems = (state: ActivityState) =>
  state.items.filter((i) => i.type === "toolCall") as Extract<ActivityItem, { type: "toolCall" }>[];

describe("activityReducer — streaming text", () => {
  it("appends to the in-flight agent message rather than starting a new one", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } }),
    );

    expect(state.items).toHaveLength(1);
    expect(lastItem(state)).toMatchObject({
      type: "message",
      item: { text: "Hello world", isStreaming: true },
    });
  });

  it("finalizes a streaming thought before starting an agent message", () => {
    let state = makeState({ items: [thinkingItem("pondering", true)] });
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } }),
    );

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ type: "thinking", item: { isStreaming: false } });
    expect(state.items[1]).toMatchObject({ type: "message", item: { isStreaming: true } });
  });

  it("resumes a thought that was interrupted by a tool call, matching on messageId", () => {
    // A thought can be split by an interleaved tool call. The reducer has to find the
    // most recent thinking item rather than appending to the list tail.
    let state = makeState({
      items: [
        thinkingItem("first half", true, "msg-1"),
        { type: "toolCall", item: toolCall("tc-1") },
      ],
    });
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " second half" },
        messageId: "msg-1",
      }),
    );

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      type: "thinking",
      item: { text: "first half second half", isStreaming: true },
    });
    // The tool call must stay after the thought it interrupted.
    expect(state.items[1].type).toBe("toolCall");
  });

  it("starts a new thought when the most recent one has a different messageId", () => {
    // The previous thought is already finalized, so the messageId lookup decides.
    let state = makeState({
      items: [thinkingItem("older", false, "msg-1"), { type: "toolCall", item: toolCall("tc-1") }],
    });
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "newer" },
        messageId: "msg-2",
      }),
    );

    expect(state.items).toHaveLength(3);
    expect(state.items[0]).toMatchObject({ item: { text: "older", isStreaming: false } });
    expect(lastItem(state)).toMatchObject({
      type: "thinking",
      item: { text: "newer", isStreaming: true },
    });
  });

  it("starts a new thought when a differing messageId arrives mid-stream", () => {
    // ACP: "A change in messageId indicates a new message has started." The previous
    // thought is still streaming, but the id says it is over.
    const state = activityReducer(
      makeState({ items: [thinkingItem("older", true, "msg-1")] }),
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "newer" },
        messageId: "msg-2",
      }),
    );

    expect(state.items).toHaveLength(2);
    expect(state.items[0].item).toMatchObject({ text: "older", isStreaming: false });
    expect(lastItem(state).item).toMatchObject({ text: "newer", messageId: "msg-2" });
  });

  it("keeps two agent messages separate when their messageIds differ", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
        messageId: "A",
      }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second" },
        messageId: "B",
      }),
    );

    expect(state.items.map((i) => (i.item as MessageItem).text)).toEqual(["first", "second"]);
    expect(state.items[0].item).toMatchObject({ isStreaming: false });
  });

  it("keeps merging chunks from agents that never send a messageId", () => {
    // The field is optional in ACP. Treating "absent" as a boundary would split every
    // message of every agent that omits it.
    let state = makeState();
    for (const text of ["a", "b", "c"]) {
      state = activityReducer(
        state,
        event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
      );
    }

    expect(state.items).toHaveLength(1);
    expect((lastItem(state).item as MessageItem).text).toBe("abc");
  });

  it("adopts the first messageId it learns so a later chunk can resume the block", () => {
    // A block opened by an id-less chunk would otherwise never match again.
    let state = makeState();
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "start" } }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " more" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "T", kind: "read" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " end" },
        messageId: "msg-1",
      }),
    );

    const thoughts = state.items.filter((i) => i.type === "thinking");
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].item).toMatchObject({ text: "start more end", messageId: "msg-1" });
  });

  it("resumes a message that a tool call interrupted, matching on messageId", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "T", kind: "read" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " after" },
        messageId: "msg-1",
      }),
    );

    const messages = state.items.filter((i) => i.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].item).toMatchObject({ text: "before after", messageId: "msg-1" });
    expect(toolCallItems(state)).toHaveLength(1);
  });

  it("starts a new message when the id changes across a tool call", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "T", kind: "read" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after" },
        messageId: "msg-2",
      }),
    );

    expect(state.items.filter((i) => i.type === "message").map((i) => i.item.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("does not split a message when a background tool call reports progress", () => {
    // A subagent running in the background emits tool_call_update while the main agent is
    // mid-sentence. The frame revises a card already in the list and appends nothing, so it
    // must not end the message — it used to, splitting one reply mid-word.
    let state = makeState();
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Task", kind: "other" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Three" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " agents out" },
        messageId: "msg-1",
      }),
    );

    const messages = state.items.filter((i) => i.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].item).toMatchObject({ text: "Three agents out", isStreaming: true });
  });

  it("does not split a message when a plan update arrives mid-sentence", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "half " } }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "plan",
        entries: [{ content: "step", priority: "high", status: "pending" }],
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "written" } }),
    );

    expect(state.items).toHaveLength(1);
    expect(lastItem(state).item).toMatchObject({ text: "half written" });
    expect(state.plan).toHaveLength(1);
  });

  it("does not split a user message that arrives as several chunks of one message", () => {
    let state = makeState({ suppressUserChunks: false });
    state = activityReducer(
      state,
      event({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "one " },
        messageId: "u1",
      }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "two" },
        messageId: "u1",
      }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "separate" },
        messageId: "u2",
      }),
    );

    const contents = state.items.map((i) => (i.item as UserMessageItem).content);
    expect(contents).toEqual(["one two", "separate"]);
  });

  it("marks the turn active on a turn-progress event", () => {
    const state = activityReducer(
      makeState({ isTurnActive: false }),
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }),
    );
    expect(state.isTurnActive).toBe(true);
  });

  // Agents emit these after session/load and after a turn ends. No turn_ended follows,
  // so arming isTurnActive here strands the session as "thinking" forever.
  it.each([
    "usage_update",
    "available_commands_update",
    "config_option_update",
    "current_model_update",
    "current_mode_update",
  ])("leaves the turn inactive on the out-of-turn %s event", (sessionUpdate) => {
    const state = activityReducer(
      makeState({ isTurnActive: false }),
      event({ sessionUpdate } as unknown as SessionUpdatePayload),
    );
    expect(state.isTurnActive).toBe(false);
  });
});

describe("activityReducer — finalize_streaming", () => {
  it.each([
    ["message", messageItem("streaming", true)],
    ["thinking", thinkingItem("streaming", true)],
  ])("clears the streaming flag on a trailing %s item", (_kind, item) => {
    const state = activityReducer(makeState({ items: [item] }), { type: "finalize_streaming" });
    expect(lastItem(state).item).toMatchObject({ isStreaming: false });
  });

  it("leaves an already-finalized item untouched", () => {
    const items = [messageItem("done", false)];
    const state = activityReducer(makeState({ items }), { type: "finalize_streaming" });
    expect(state.items).toBe(items);
  });

  it("clears the flag on an item that is no longer last", () => {
    // Resuming a thought re-marks an item buried behind the tool call that interrupted it.
    // A tail-only sweep would strand that flag: ActivityThinkingBlock renders a streaming
    // thought as a shimmering, non-collapsible panel, so it would never settle.
    const state = activityReducer(
      makeState({
        items: [
          thinkingItem("resumed", true, "msg-1"),
          { type: "toolCall", item: toolCall("tc-1") },
        ],
      }),
      { type: "finalize_streaming" },
    );
    expect(state.items[0].item).toMatchObject({ isStreaming: false });
  });

  it("settles a thought resumed after a tool call once the turn ends", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "start" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read", kind: "read" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " end" },
        messageId: "msg-1",
      }),
    );
    state = activityReducer(state, { type: "turn_ended" });

    expect(state.items[0]).toMatchObject({
      type: "thinking",
      item: { text: "start end", isStreaming: false },
    });
  });

  it("is a no-op on an empty transcript", () => {
    const state = activityReducer(makeState(), { type: "finalize_streaming" });
    expect(state.items).toHaveLength(0);
  });
});

describe("activityReducer — tool call parenting", () => {
  it("attaches a child that arrives after its parent, without listing it separately", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "parent", title: "Task", kind: "think" }),
    );
    state = activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call", toolCallId: "child", title: "Read", kind: "read" },
        childOf("parent"),
      ),
    );

    expect(toolCallItems(state)).toHaveLength(1);
    expect(state.toolCallMap.get("parent")?.childToolCallIds).toEqual(["child"]);
    expect(state.toolCallMap.get("child")?.parentToolCallId).toBe("parent");
  });

  it("holds a child that arrives before its parent instead of rendering it at top level", () => {
    const state = activityReducer(
      makeState(),
      event(
        { sessionUpdate: "tool_call", toolCallId: "child", title: "Read", kind: "read" },
        childOf("parent"),
      ),
    );

    expect(toolCallItems(state)).toHaveLength(0);
    expect(state.pendingOrphans.get("parent")).toEqual(["child"]);
    // Still tracked, so a later update can find it.
    expect(state.toolCallMap.has("child")).toBe(true);
  });

  it("adopts waiting orphans when the parent finally arrives", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call", toolCallId: "child-a", title: "A", kind: "read" },
        childOf("parent"),
      ),
    );
    state = activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call", toolCallId: "child-b", title: "B", kind: "read" },
        childOf("parent"),
      ),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "tool_call", toolCallId: "parent", title: "Task", kind: "think" }),
    );

    expect(state.toolCallMap.get("parent")?.childToolCallIds).toEqual(["child-a", "child-b"]);
    expect(state.pendingOrphans.has("parent")).toBe(false);
    expect(toolCallItems(state)).toHaveLength(1);
  });

  it("keeps AskUserQuestion out of the transcript but still tracks it", () => {
    // The elicitation panel renders this one; a generic tool card would duplicate it.
    const state = activityReducer(
      makeState(),
      event(
        { sessionUpdate: "tool_call", toolCallId: "ask-1", title: "Ask", kind: "think" },
        {
          _meta: { claudeCode: { toolName: "AskUserQuestion" } },
        },
      ),
    );

    expect(toolCallItems(state)).toHaveLength(0);
    expect(state.toolCallMap.has("ask-1")).toBe(true);
  });
});

describe("activityReducer — tool_call_update", () => {
  it("translates the wire status 'failed' to 'error'", () => {
    const state = activityReducer(
      makeState({
        items: [{ type: "toolCall", item: toolCall("tc-1", { status: "in_progress" }) }],
        toolCallMap: new Map([["tc-1", toolCall("tc-1", { status: "in_progress" })]]),
      }),
      event({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "failed" }),
    );

    expect(state.toolCallMap.get("tc-1")?.status).toBe("error");
    expect(toolCallItems(state)[0].item.status).toBe("error");
  });

  it("ignores an update for a tool call it has never seen", () => {
    const state = activityReducer(
      makeState({ items: [messageItem("hi", true)] }),
      event({ sessionUpdate: "tool_call_update", toolCallId: "unknown", status: "completed" }),
    );

    expect(state.toolCallMap.size).toBe(0);
    // An update that went nowhere has even less business ending the message being streamed.
    expect(lastItem(state).item).toMatchObject({ isStreaming: true });
  });

  it("lifts the plan title out of the 'Ready to code?' payload", () => {
    const state = activityReducer(
      makeState({ toolCallMap: new Map([["tc-1", toolCall("tc-1")]]) }),
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "Ready to code?",
        rawInput: { plan: "# Ship the thing\n\nsome detail" },
      }),
    );

    expect(state.planTitle).toBe("Ship the thing");
  });

  it("does not invent a plan title from an ordinary update", () => {
    const state = activityReducer(
      makeState({ toolCallMap: new Map([["tc-1", toolCall("tc-1")]]) }),
      event({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        title: "Editing file",
        rawInput: { plan: "# Not a plan prompt" },
      }),
    );

    expect(state.planTitle).toBeNull();
  });
});

describe("activityReducer — end of turn and session", () => {
  function stateWithStalledWork(): ActivityState {
    const running = toolCall("running", { status: "in_progress" });
    const queued = toolCall("queued", { status: "pending" });
    const finished = toolCall("finished", { status: "completed" });
    return makeState({
      items: [
        { type: "toolCall", item: running },
        { type: "toolCall", item: queued },
        { type: "toolCall", item: finished },
        messageItem("mid-sentence", true),
      ],
      toolCallMap: new Map([
        ["running", running],
        ["queued", queued],
        ["finished", finished],
      ]),
    });
  }

  it.each([["turn_ended"], ["session_ended"]] as const)(
    "%s marks unfinished tool calls as interrupted, in both the map and the transcript",
    (type) => {
      const state = activityReducer(stateWithStalledWork(), { type });

      expect(state.toolCallMap.get("running")?.status).toBe("interrupted");
      expect(state.toolCallMap.get("queued")?.status).toBe("interrupted");
      expect(state.toolCallMap.get("finished")?.status).toBe("completed");

      const rendered = Object.fromEntries(
        toolCallItems(state).map((i) => [i.item.toolCallId, i.item.status]),
      );
      expect(rendered).toEqual({
        running: "interrupted",
        queued: "interrupted",
        finished: "completed",
      });
    },
  );

  it.each([["turn_ended"], ["session_ended"]] as const)(
    "%s finalizes the trailing streaming message",
    (type) => {
      const state = activityReducer(stateWithStalledWork(), { type });
      expect(lastItem(state).item).toMatchObject({ isStreaming: false });
    },
  );

  it("session_ended records completion; turn_ended leaves the session open", () => {
    const ended = activityReducer(makeState({ isTurnActive: true }), { type: "session_ended" });
    expect(ended).toMatchObject({
      isTurnActive: false,
      sessionEnded: true,
      endReason: "completed",
    });

    const turn = activityReducer(makeState({ isTurnActive: true }), { type: "turn_ended" });
    expect(turn).toMatchObject({ isTurnActive: false, sessionEnded: false, endReason: null });
  });

  it("surfaces orphaned children at the end rather than dropping them", () => {
    // A child whose parent never arrived would otherwise be invisible forever.
    const orphan = toolCall("orphan", { status: "completed", parentToolCallId: "never-arrives" });
    const state = activityReducer(
      makeState({
        toolCallMap: new Map([["orphan", orphan]]),
        pendingOrphans: new Map([["never-arrives", ["orphan"]]]),
      }),
      { type: "session_ended" },
    );

    expect(toolCallItems(state).map((i) => i.item.toolCallId)).toEqual(["orphan"]);
    expect(state.pendingOrphans.size).toBe(0);
    // Promoted to top level, since the parent it referenced never showed up.
    expect(state.toolCallMap.get("orphan")?.parentToolCallId).toBeUndefined();
  });
});

describe("activityReducer — user messages", () => {
  it("suppresses the agent's echo of a message the UI already recorded", () => {
    let state = activityReducer(
      makeState(),
      event({ sessionUpdate: "user_message", content: "do the thing", sentAt: 1 }),
    );
    expect(state.suppressUserChunks).toBe(true);

    const before = state.items;
    state = activityReducer(
      state,
      event({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "do the thing" },
      }),
    );

    expect(state.items).toBe(before);
    expect(state.items).toHaveLength(1);
  });

  it("accumulates chunks during replay, when no user_message fires", () => {
    let state = makeState({ suppressUserChunks: false });
    state = activityReducer(
      state,
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "part one" } }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: " part two" } }),
    );

    expect(state.items).toHaveLength(1);
    expect((lastItem(state).item as UserMessageItem).content).toBe("part one part two");
  });
});

describe("activityReducer — canvases and terminals", () => {
  it("accumulates terminal output per terminal id", () => {
    let state = activityReducer(makeState(), {
      type: "terminal_output",
      terminalId: "t1",
      output: "line 1\n",
    });
    state = activityReducer(state, {
      type: "terminal_output",
      terminalId: "t1",
      output: "line 2\n",
    });
    state = activityReducer(state, {
      type: "terminal_output",
      terminalId: "t2",
      output: "other\n",
    });

    expect(state.terminalBuffers.get("t1")).toBe("line 1\nline 2\n");
    expect(state.terminalBuffers.get("t2")).toBe("other\n");
  });

  it("bounds the catch-up buffer once it passes the trim trigger", () => {
    // 60 chars per line; 30k lines is ~1.8M chars, well past the 1M trigger.
    const line = `${"x".repeat(59)}\n`;
    let state = makeState();
    for (let i = 0; i < 30_000; i++) {
      state = activityReducer(state, { type: "terminal_output", terminalId: "t1", output: line });
    }

    const buffer = state.terminalBuffers.get("t1")!;
    expect(buffer.length).toBeLessThanOrEqual(1_000_000);
    // The most recent output is what a late-opening tab needs, so the tail must survive.
    expect(buffer.endsWith(line)).toBe(true);
    // Trimming cuts at a line boundary, never mid-line.
    expect(buffer.startsWith("x".repeat(59))).toBe(true);
  });

  it("leaves short terminal output untouched", () => {
    let state = makeState();
    for (let i = 0; i < 100; i++) {
      state = activityReducer(state, {
        type: "terminal_output",
        terminalId: "t1",
        output: `line ${i}\n`,
      });
    }
    expect(state.terminalBuffers.get("t1")).toContain("line 0\n");
    expect(state.terminalBuffers.get("t1")).toContain("line 99\n");
  });

  it("merges canvas components by id instead of appending duplicates", () => {
    let state = activityReducer(
      makeState(),
      event({ sessionUpdate: "canvas_create", surfaceId: "s1", catalogId: "c1", title: "Chart" }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        components: [{ id: "a", component: "Text" }],
      }),
    );
    state = activityReducer(
      state,
      event({
        sessionUpdate: "canvas_update",
        surfaceId: "s1",
        components: [{ id: "a", component: "Heading" }],
      }),
    );

    const components = state.canvasMap.get("s1")!.components;
    expect(components).toHaveLength(1);
    expect(components[0].component).toBe("Heading");
  });

  it("ignores canvas data addressed to a surface that does not exist", () => {
    const state = activityReducer(
      makeState(),
      event({ sessionUpdate: "canvas_data", surfaceId: "missing", path: "/rows", value: [1, 2] }),
    );
    expect(state.canvasMap.size).toBe(0);
  });

  it("restores canvases without duplicating ones already present", () => {
    const surface = { surfaceId: "s1", catalogId: "c1", title: "Chart", components: [], data: {} };
    let state = activityReducer(makeState(), { type: "restore_canvases", surfaces: [surface] });
    state = activityReducer(state, { type: "restore_canvases", surfaces: [surface] });

    expect(state.canvasMap.size).toBe(1);
    expect(state.items.filter((i) => i.type === "canvas")).toHaveLength(1);
  });
});

describe("activityReducer — invariants", () => {
  it("leaves the previous state untouched", () => {
    const existing = toolCall("tc-1", { status: "in_progress" });
    const previous = makeState({
      items: [{ type: "toolCall", item: existing }, messageItem("streaming", true)],
      toolCallMap: new Map([["tc-1", existing]]),
      terminalBuffers: new Map([["t1", "before"]]),
    });
    const snapshot = {
      itemCount: previous.items.length,
      status: previous.toolCallMap.get("tc-1")!.status,
      streaming: (previous.items[1].item as MessageItem).isStreaming,
      terminal: previous.terminalBuffers.get("t1"),
    };

    activityReducer(previous, { type: "session_ended" });
    activityReducer(previous, { type: "terminal_output", terminalId: "t1", output: "after" });
    activityReducer(
      previous,
      event({ sessionUpdate: "tool_call", toolCallId: "tc-2", title: "T", kind: "read" }),
    );

    expect(previous.items).toHaveLength(snapshot.itemCount);
    expect(previous.toolCallMap.get("tc-1")!.status).toBe(snapshot.status);
    expect((previous.items[1].item as MessageItem).isStreaming).toBe(snapshot.streaming);
    expect(previous.terminalBuffers.get("t1")).toBe(snapshot.terminal);
  });

  it("returns the same state for an unrecognized action", () => {
    const state = makeState();
    expect(activityReducer(state, { type: "not_a_real_action" } as unknown as ActivityAction)).toBe(
      state,
    );
  });
});
