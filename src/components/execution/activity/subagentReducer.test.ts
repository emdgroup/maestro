import { describe, expect, it } from "vitest";
import { activityReducer, type ActivityAction } from "./activityReducer";
import { subagentPhase } from "./subagentReducer";
import { INITIAL_ACTIVITY_STATE } from "./types";
import type { ActivityState, SessionUpdatePayload } from "./types";

const ROOT = "root-session";
const CHILD = "child-session";
const CARD = `subagent:${CHILD}`;

function makeState(overrides: Partial<ActivityState> = {}): ActivityState {
  return {
    ...INITIAL_ACTIVITY_STATE,
    items: [],
    toolCallMap: new Map(),
    canvasMap: new Map(),
    terminalBuffers: new Map(),
    isInitializing: false,
    ...overrides,
  };
}

/** An update as the daemon forwards it; `from` names the subagent whose own stream it is. */
function event(payload: Record<string, unknown>, from?: string): ActivityAction {
  const raw = from ? { ...payload, childSessionId: from } : payload;
  return { type: "event", payload: payload as unknown as SessionUpdatePayload, raw };
}

const text = (t: string) => [{ type: "text", text: t }];

function run(state: ActivityState, ...actions: ActivityAction[]): ActivityState {
  return actions.reduce(activityReducer, state);
}

/** The frames claude-agent-acp 0.108 sends for one foreground subagent, in order. */
function claudeSubagent(state = makeState()): ActivityState {
  return run(
    state,
    event({
      sessionUpdate: "subagent_update",
      sessionId: CHILD,
      title: "Count lines in all files",
      description: "general-purpose",
      capabilities: { cancel: {} },
      state: { state: "running" },
    }),
    // The prompt, once in each transcript.
    event({
      sessionUpdate: "session_message",
      messageId: "toolu_1",
      senderSessionId: ROOT,
      recipientSessionId: CHILD,
      content: text("Count the lines"),
    }),
    event(
      {
        sessionUpdate: "session_message",
        messageId: "toolu_1",
        senderSessionId: ROOT,
        recipientSessionId: CHILD,
        content: text("Count the lines"),
      },
      CHILD,
    ),
    event(
      {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "model", category: "model", currentValue: "opus", name: "Model", options: [] },
          { id: "agent", currentValue: "general-purpose", name: "Agent", options: [] },
        ],
      },
      CHILD,
    ),
    event(
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "wc -l *", kind: "execute" },
      CHILD,
    ),
    event({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }, CHILD),
  );
}

const report = (from?: string) =>
  event(
    {
      sessionUpdate: "session_message",
      messageId: "toolu_2",
      senderSessionId: CHILD,
      recipientSessionId: ROOT,
      content: text("3 files, 8 lines."),
    },
    from,
  );

describe("subagentReducer", () => {
  it("draws a running subagent as one card, its tool calls inside it", () => {
    const state = claudeSubagent();
    const card = state.toolCallMap.get(CARD)!;

    expect(state.items.map((i) => i.type === "toolCall" && i.item.toolCallId)).toEqual([CARD]);
    expect(card).toMatchObject({
      title: "Count lines in all files",
      kind: "subagent",
      status: "in_progress",
      rawInput: { prompt: "Count the lines" },
      childToolCallIds: [`${CHILD}/t1`],
      meta: { model: "opus", agentType: "general-purpose" },
    });
    expect(card.meta?.subagent).toMatchObject({ canCancel: true, promptMessageId: "toolu_1" });
    expect(state.toolCallMap.get(`${CHILD}/t1`)).toMatchObject({
      status: "completed",
      parentToolCallId: CARD,
    });
    expect(subagentPhase(card)).toBe("running");
  });

  it("keeps the hand-back as its report once, and times a run it watched", () => {
    let state = run(claudeSubagent(), report(), report(CHILD));
    state = activityReducer(
      state,
      event({
        sessionUpdate: "subagent_update",
        sessionId: CHILD,
        state: { state: "idle", stopReason: "end_turn" },
      }),
    );
    const card = state.toolCallMap.get(CARD)!;

    expect(card.content).toEqual([
      { type: "content", content: { type: "text", text: "3 files, 8 lines." } },
    ]);
    expect(subagentPhase(card)).toBe("done");
    expect(card.status).toBe("completed");
    expect(card.meta?.subagent?.canCancel).toBe(false);
    expect(card.meta?.subagent?.endedAt).toBeGreaterThanOrEqual(card.meta!.subagent!.startedAt!);
  });

  it("names a subagent without a title by its prompt, and reads its own messages as the report", () => {
    const state = run(
      makeState(),
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, capabilities: {} }),
      event({
        sessionUpdate: "session_message",
        messageId: "m1",
        senderSessionId: ROOT,
        recipientSessionId: CHILD,
        content: text("Count the lines of every file\nthen report"),
      }),
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, state: { state: "running" } }),
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, capabilities: { cancel: {} } }),
      event(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a.txt 3" } },
        CHILD,
      ),
      event(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ", b.txt 2" } },
        CHILD,
      ),
      event({
        sessionUpdate: "subagent_update",
        sessionId: CHILD,
        state: { state: "idle", stopReason: "end_turn" },
      }),
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, capabilities: { cancel: null } }),
      // Codex marks a subagent it closed as unknown: what was seen of it stands.
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, state: { state: "unknown" } }),
    );
    const card = state.toolCallMap.get(CARD)!;

    expect(card.title).toBe("Count the lines of every file");
    expect(card.content).toEqual([
      { type: "content", content: { type: "text", text: "a.txt 3, b.txt 2" } },
    ]);
    expect(subagentPhase(card)).toBe("done");
  });

  it("tells a stopped subagent from a failed one", () => {
    const end = (state: Record<string, unknown>) =>
      run(claudeSubagent(), event({ sessionUpdate: "subagent_update", sessionId: CHILD, state }));

    const stopped = end({ state: "idle", stopReason: "cancelled" }).toolCallMap.get(CARD)!;
    expect(subagentPhase(stopped)).toBe("stopped");

    const failed = end({
      state: "idle",
      stopReason: "end_turn",
      error: { message: "Rate limited" },
    }).toolCallMap.get(CARD)!;
    expect(subagentPhase(failed)).toBe("failed");
    expect(failed.meta?.subagent?.error).toBe("Rate limited");

    const unknown = run(
      makeState(),
      event({ sessionUpdate: "subagent_update", sessionId: CHILD, state: { state: "unknown" } }),
    ).toolCallMap.get(CARD)!;
    expect(subagentPhase(unknown)).toBe("unknown");

    const asking = end({ state: "requires_action" }).toolCallMap.get(CARD)!;
    expect(subagentPhase(asking)).toBe("needs");
  });

  it("grants nothing from a replay, and times nothing", () => {
    const card = claudeSubagent(makeState({ isInitializing: true })).toolCallMap.get(CARD)!;
    expect(card.meta?.subagent).toMatchObject({ canCancel: false, startedAt: undefined });
  });

  it("puts a subagent's own subagent inside its card", () => {
    const state = run(
      claudeSubagent(),
      event(
        {
          sessionUpdate: "subagent_update",
          sessionId: "grandchild",
          title: "Find callers",
          state: { state: "running" },
        },
        CHILD,
      ),
    );

    expect(state.items).toHaveLength(1);
    expect(state.toolCallMap.get(CARD)?.childToolCallIds).toContain("subagent:grandchild");
    expect(state.toolCallMap.get("subagent:grandchild")?.parentToolCallId).toBe(CARD);
  });

  it("lets a subagent outlive the turn, and ends it with the session", () => {
    const afterTurn = activityReducer(claudeSubagent(), {
      type: "turn_ended",
      stopReason: "end_turn",
    });
    expect(subagentPhase(afterTurn.toolCallMap.get(CARD)!)).toBe("running");

    const running = run(
      claudeSubagent(),
      event(
        { sessionUpdate: "tool_call", toolCallId: "t2", title: "sleep", kind: "execute" },
        CHILD,
      ),
    );
    const kept = activityReducer(running, { type: "turn_ended" });
    expect(kept.toolCallMap.get(`${CHILD}/t2`)?.status).toBe("pending");

    const ended = activityReducer(running, { type: "session_ended" });
    expect(subagentPhase(ended.toolCallMap.get(CARD)!)).toBe("stopped");
    expect(ended.toolCallMap.get(`${CHILD}/t2`)?.status).toBe("interrupted");
  });

  it("keeps the subagent's model and usage off the session", () => {
    const state = run(
      claudeSubagent(),
      event({ sessionUpdate: "usage_update", used: 9000, size: 200000 }, CHILD),
    );
    expect(state.contextUsed).toBeNull();
    expect(state.items).toHaveLength(1);
  });

  it("no longer files a call under another by Claude's parentToolUseId", () => {
    const state = activityReducer(
      makeState(),
      event({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        _meta: { claudeCode: { parentToolUseId: "toolu_x" } },
      }),
    );
    expect(state.items).toHaveLength(1);
    expect(state.toolCallMap.get("t1")?.parentToolCallId).toBeUndefined();
  });
});
