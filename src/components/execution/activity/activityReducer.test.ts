import { describe, expect, it } from "vitest";
import { activityReducer, type ActivityAction } from "./activityReducer";
import { rowLabel } from "./tool-call-labels";
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

  it("runs a turn from turn_started to turn_ended", () => {
    const started = activityReducer(makeState({ isTurnActive: false }), { type: "turn_started" });
    expect(started.isTurnActive).toBe(true);
    expect(activityReducer(started, { type: "turn_ended" }).isTurnActive).toBe(false);
  });

  // Claude reports a background subagent's end, and its own summary of it, with no prompt
  // outstanding. No turn_ended follows, so arming isTurnActive here strands the session as
  // "thinking" forever. The same goes for what agents emit after session/load.
  it.each([
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "usage_update",
    "available_commands_update",
    "config_option_update",
    "current_model_update",
    "current_mode_update",
  ])("leaves the turn inactive on an unprompted %s event", (sessionUpdate) => {
    const state = activityReducer(
      makeState({ isTurnActive: false }),
      event({
        sessionUpdate,
        content: { type: "text", text: "x" },
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        status: "pending",
      } as unknown as SessionUpdatePayload),
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

  it("adopts a kind the create frame could not supply", () => {
    const state = activityReducer(
      makeState({
        items: [{ type: "toolCall", item: toolCall("tc-1", { kind: "other" }) }],
        toolCallMap: new Map([["tc-1", toolCall("tc-1", { kind: "other" })]]),
      }),
      event(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          kind: "execute",
          rawInput: { command: "git status", description: "Check the working tree" },
        },
        { rawInput: { command: "git status", description: "Check the working tree" } },
      ),
    );

    const tc = state.toolCallMap.get("tc-1")!;
    expect(tc.kind).toBe("execute");
    // The whole point of adopting it: the row can now prefer the description.
    expect(rowLabel(tc)).toBe("Check the working tree");
  });

  it("keeps the kind an update leaves out", () => {
    const state = activityReducer(
      makeState({ toolCallMap: new Map([["tc-1", toolCall("tc-1", { kind: "execute" })]]) }),
      event({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" }),
    );

    expect(state.toolCallMap.get("tc-1")?.kind).toBe("execute");
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

  it("replaces the canvas document on an untargeted update", () => {
    let state = activityReducer(
      makeState(),
      event({
        sessionUpdate: "canvas_create",
        surfaceId: "s1",
        title: "Chart",
        html: "<p id='a'>one</p>",
      }),
    );
    state = activityReducer(
      state,
      event({ sessionUpdate: "canvas_update", surfaceId: "s1", html: "<p id='a'>two</p>" }),
    );

    expect(state.canvasMap.get("s1")!.html).toBe("<p id='a'>two</p>");
  });

  it("ignores canvas data addressed to a surface that does not exist", () => {
    const state = activityReducer(
      makeState(),
      event({ sessionUpdate: "canvas_data", surfaceId: "missing", path: "/rows", value: [1, 2] }),
    );
    expect(state.canvasMap.size).toBe(0);
  });

  it("restores canvases without duplicating ones already present", () => {
    const surface = {
      surfaceId: "s1",
      title: "Chart",
      html: "<p id='a'>one</p>",
      theme: "maestro" as const,
      sources: [],
      data: {},
      createdAt: 0,
    };
    let state = activityReducer(makeState(), { type: "restore_canvases", surfaces: [surface] });
    state = activityReducer(state, { type: "restore_canvases", surfaces: [surface] });

    expect(state.canvasMap.size).toBe(1);
    expect(state.items.filter((i) => i.type === "canvas")).toHaveLength(1);
  });

  it("closes one surface and leaves the others", () => {
    let state = makeState();
    for (const surfaceId of ["s1", "s2"]) {
      state = activityReducer(
        state,
        event({ sessionUpdate: "canvas_create", surfaceId, title: surfaceId, html: "<p>x</p>" }),
      );
    }
    state = activityReducer(state, { type: "close_canvas", surfaceId: "s1" });

    expect([...state.canvasMap.keys()]).toEqual(["s2"]);
    expect(state.items.filter((i) => i.type === "canvas")).toHaveLength(1);
  });

  it("returns the same state when closing a surface that is not there", () => {
    const state = makeState();
    expect(activityReducer(state, { type: "close_canvas", surfaceId: "gone" })).toBe(state);
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

describe("activityReducer — context compaction", () => {
  const update = (status: string, over: Record<string, unknown> = {}) =>
    event({ sessionUpdate: "compaction_update", compactionId: "c1", status, ...over });
  const chunk = (text: string) =>
    event({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c1",
      content: { type: "text", text },
    });
  const usage = (used: number) => event({ sessionUpdate: "usage_update", used, size: 200_000 });
  const run = (...actions: ActivityAction[]) => actions.reduce(activityReducer, makeState());
  const row = (state: ActivityState) => state.toolCallMap.get("compaction:c1")!;

  it("adds one row in the stream and updates it in place", () => {
    const state = run(update("in_progress"), update("completed"));
    expect(toolCallItems(state)).toHaveLength(1);
    expect(row(state)).toMatchObject({ kind: "compact", status: "completed" });
    expect(rowLabel(row(state))).toBe("Compacted context");
  });

  it("creates the row from a first summary chunk and joins later chunks into one text", () => {
    const state = run(chunk("**Goal:** retries"), chunk(" with backoff"));
    expect(row(state).status).toBe("in_progress");
    expect(row(state).content).toEqual([
      { type: "content", content: { type: "text", text: "**Goal:** retries with backoff" } },
    ]);
  });

  it("treats summary and error as patches", () => {
    let state = run(chunk("kept"), update("in_progress"));
    expect(row(state).content).toHaveLength(1);
    state = activityReducer(state, update("in_progress", { summary: null }));
    expect(row(state).content).toEqual([]);
    state = activityReducer(state, update("failed", { error: "timed out" }));
    expect(row(state)).toMatchObject({ status: "error", meta: { errorText: "timed out" } });
    expect(rowLabel(row(state))).toBe("Compaction failed");
  });

  it("shows a cancelled compaction as stopped", () => {
    const state = run(update("in_progress"), update("cancelled"));
    expect(row(state).status).toBe("interrupted");
    expect(rowLabel(row(state))).toBe("Compaction stopped");
  });

  it("keeps the last status for one it does not know", () => {
    expect(
      run(update("completed"), update("_vendor_status")).toolCallMap.get("compaction:c1")!.status,
    ).toBe("completed");
  });

  it("reads tokens before from the last usage and after from the next one", () => {
    const state = run(
      event({ sessionUpdate: "user_message", content: "Add retries", sentAt: 1 }),
      usage(182_000),
      update("in_progress"),
      update("completed"),
      usage(41_000),
      usage(45_000),
    );
    expect(row(state).meta?.compaction).toEqual({
      trigger: "auto",
      tokensBefore: 182_000,
      tokensAfter: 41_000,
    });
    expect(state.compactionAwaitingUsage).toBeNull();
  });

  it("is manual when the turn was the user's /compact", () => {
    const state = run(
      event({ sessionUpdate: "user_message", content: "/compact", sentAt: 1 }),
      update("in_progress"),
    );
    expect(row(state).meta?.compaction?.trigger).toBe("manual");
  });

  it("names no trigger in a reopened session, whose history starts at the compaction", () => {
    expect(row(run(update("completed"))).meta?.compaction?.trigger).toBeUndefined();
  });

  it("leaves the state untouched for a usage it already has", () => {
    const state = run(usage(10));
    expect(activityReducer(state, usage(10))).toBe(state);
  });
});

describe("activityReducer — notices", () => {
  const notice = (title: string, severity = "warning", description?: string) =>
    event({ sessionUpdate: "notice", severity, title, description });
  const notices = (state: ActivityState) =>
    state.items.flatMap((i) => (i.type === "notice" ? [i.item] : []));

  it("adds a row where the notice arrived", () => {
    const state = [
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } }),
      notice("Fast mode turned off", "warning", "Not available for the selected model."),
    ].reduce(activityReducer, makeState());
    expect(lastItem(state)).toMatchObject({
      type: "notice",
      item: {
        title: "Fast mode turned off",
        description: "Not available for the selected model.",
        count: 1,
      },
    });
    expect(state.items[0]).toMatchObject({ type: "message", item: { isStreaming: false } });
  });

  it("says once in the session that Claude refused for a plan limit", () => {
    const usage = (status: string) => {
      const raw = {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        _meta: {
          "_claude/rateLimit": {
            status,
            rateLimitType: "five_hour",
            resetsAt: 1_791_677_400,
            unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_791_677_400 } },
          },
        },
      };
      return event(raw as unknown as SessionUpdatePayload, raw);
    };
    const allowed = [usage("allowed")].reduce(activityReducer, makeState());
    expect(notices(allowed)).toHaveLength(0);
    const refused = [usage("rejected"), usage("rejected")].reduce(activityReducer, makeState());
    expect(notices(refused)).toMatchObject([
      { title: "Claude 5-hour limit reached", severity: "warning", count: 1 },
    ]);
    expect(refused.contextUsed).toBe(10);
  });

  it("counts a repeat on one row and moves it to the bottom", () => {
    const state = [
      notice("Auto mode unavailable"),
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Next" } }),
      notice("Auto mode unavailable"),
    ].reduce(activityReducer, makeState());
    expect(notices(state)).toHaveLength(1);
    expect(lastItem(state)).toMatchObject({ type: "notice", item: { count: 2 } });
  });

  it("keeps notices with a different description apart", () => {
    const state = [
      notice("Codex warning", "warning", "a"),
      notice("Codex warning", "warning", "b"),
    ].reduce(activityReducer, makeState());
    expect(notices(state)).toHaveLength(2);
  });

  it("ignores a notice without a title", () => {
    const state = makeState();
    expect(activityReducer(state, notice(""))).toBe(state);
  });
});

describe("activityReducer — background subagents", () => {
  const PROMPT = "Run `sleep 6` with Bash, then reply with its output.";
  const agentMeta = (extra: Record<string, unknown> = {}) => ({
    _meta: { claudeCode: { toolName: "Agent", ...extra } },
  });
  const childMeta = (toolName: string) => ({
    _meta: { claudeCode: { toolName, parentToolUseId: "agent" } },
  });

  /** The frames claude-agent-acp 0.86 sends for an Agent call with `run_in_background`. */
  function launched(): ActivityState {
    let state = makeState({ isTurnActive: true });
    for (const [payload, raw] of [
      [
        { sessionUpdate: "tool_call", toolCallId: "agent", title: "Task", kind: "think" },
        agentMeta(),
      ],
      [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "agent",
          rawInput: { run_in_background: true, description: "Probe worker", prompt: PROMPT },
          content: [{ type: "content", content: { type: "text", text: PROMPT } }],
        },
        agentMeta(),
      ],
      [
        { sessionUpdate: "tool_call_update", toolCallId: "agent" },
        agentMeta({
          toolResponse: { isAsync: true, status: "async_launched", agentId: "a4e26c83" },
        }),
      ],
      [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "agent",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Async agent launched" } }],
        },
        agentMeta(),
      ],
      [
        { sessionUpdate: "tool_call", toolCallId: "bash", title: "sleep 6", kind: "execute" },
        childMeta("Bash"),
      ],
    ] as const) {
      state = activityReducer(state, event(payload as SessionUpdatePayload, raw));
    }
    return state;
  }

  function handBack(state: ActivityState): ActivityState {
    state = activityReducer(
      state,
      event(
        {
          sessionUpdate: "tool_call",
          toolCallId: "handback",
          title: "SubagentHandback",
          kind: "other",
          rawInput: { message: "It printed probe-ok." },
        } as SessionUpdatePayload,
        childMeta("SubagentHandback"),
      ),
    );
    return activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call_update", toolCallId: "handback", status: "completed" },
        childMeta("SubagentHandback"),
      ),
    );
  }

  it("keeps running past its launch, without the launch receipt as output", () => {
    const agent = launched().toolCallMap.get("agent")!;
    expect(agent.status).toBe("in_progress");
    expect(agent.childToolCallIds).toEqual(["bash"]);
    expect(JSON.stringify(agent.content)).not.toContain("Async agent launched");
  });

  it("survives the end of the turn that launched it", () => {
    const state = activityReducer(launched(), { type: "turn_ended" });
    expect(state.toolCallMap.get("agent")?.status).toBe("in_progress");
    expect(state.toolCallMap.get("bash")?.status).toBe("pending");
  });

  it("ends when it hands its report back, which becomes its output", () => {
    const state = handBack(launched());
    const agent = state.toolCallMap.get("agent")!;
    expect(agent.status).toBe("completed");
    expect(agent.childToolCallIds).toEqual(["bash"]);
    expect(agent.content[agent.content.length - 1]).toEqual({
      type: "content",
      content: { type: "text", text: "It printed probe-ok." },
    });
    expect(toolCallItems(state)[0].item).toBe(agent);
  });

  it("is interrupted when the session ends before it hands back", () => {
    const state = activityReducer(launched(), { type: "session_ended" });
    expect(state.toolCallMap.get("agent")?.status).toBe("interrupted");
  });

  it("is interrupted when the user stops the turn, which takes it down too", () => {
    const state = activityReducer(launched(), { type: "turn_ended", stopReason: "cancelled" });
    expect(state.toolCallMap.get("agent")?.status).toBe("interrupted");
    expect(state.toolCallMap.get("bash")?.status).toBe("interrupted");
  });

  it("is stopped by a TaskStop naming its agent id, and only that one", () => {
    let state = launched();
    const stop = (taskId: string) => {
      state = activityReducer(
        state,
        event(
          {
            sessionUpdate: "tool_call",
            toolCallId: `stop-${taskId}`,
            title: "TaskStop",
            kind: "other",
          },
          { _meta: { claudeCode: { toolName: "TaskStop" } } },
        ),
      );
      state = activityReducer(
        state,
        event(
          { sessionUpdate: "tool_call_update", toolCallId: `stop-${taskId}` },
          { _meta: { claudeCode: { toolName: "TaskStop", toolResponse: { task_id: taskId } } } },
        ),
      );
      state = activityReducer(
        state,
        event(
          { sessionUpdate: "tool_call_update", toolCallId: `stop-${taskId}`, status: "completed" },
          { _meta: { claudeCode: { toolName: "TaskStop" } } },
        ),
      );
    };
    stop("some-shell");
    expect(state.toolCallMap.get("agent")?.status).toBe("in_progress");
    stop("a4e26c83");
    expect(state.toolCallMap.get("agent")?.status).toBe("interrupted");
    expect(toolCallItems(state).find((i) => i.item.toolCallId === "agent")?.item.status).toBe(
      "interrupted",
    );
  });

  it("leaves a foreground subagent finishing at its own completion", () => {
    let state = makeState();
    state = activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call", toolCallId: "agent", title: "Task", kind: "think" },
        agentMeta(),
      ),
    );
    state = activityReducer(
      state,
      event(
        { sessionUpdate: "tool_call_update", toolCallId: "agent", status: "completed" },
        agentMeta(),
      ),
    );
    expect(state.toolCallMap.get("agent")?.status).toBe("completed");
  });
});
