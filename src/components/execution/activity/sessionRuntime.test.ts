import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (event: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));
const drainAcpReplay = vi.fn(() => Promise.resolve());
vi.mock("@/services/execution.service", () => ({ drainAcpReplay: () => drainAcpReplay() }));
vi.mock("@/services/canvas.service", () => ({
  loadSavedCanvases: () => Promise.resolve([]),
  saveCanvasSurface: () => Promise.resolve(),
}));

import {
  getActivity,
  getLifecycle,
  releaseSession,
  shownRequest,
  subscribeSession,
} from "./sessionRuntime";

const emit = (name: string, payload: unknown) => handlers.get(name)?.({ payload });
const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  messageId: "m1",
  content: { type: "text", text },
});

describe("sessionRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    drainAcpReplay.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the transcript, and what arrived meanwhile, across an unmount", async () => {
    const sid = "keeps";
    const unsubscribe = subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, chunk("before "));
    await vi.advanceTimersByTimeAsync(60);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(0);

    emit(`acp://session-update/${sid}`, chunk("after"));
    emit(`acp://permission-request/${sid}`, { request_id: "r1", payload: {} });
    await vi.advanceTimersByTimeAsync(60);

    subscribeSession(sid, () => {});
    const items = getActivity(sid).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", item: { text: "before after" } });
    expect(shownRequest(getLifecycle(sid))?.requestId).toBe("r1");
    expect(drainAcpReplay).toHaveBeenCalledTimes(1);
  });

  it("keeps a boolean option's value as text, with no choices", async () => {
    const sid = "boolean-option";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, {
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "fast", name: "Fast mode", type: "boolean", currentValue: true }],
    });
    await vi.advanceTimersByTimeAsync(60);
    const lifecycle = getLifecycle(sid);
    expect(lifecycle.configOptions[0]).toMatchObject({ currentValue: "true", options: [] });
    expect(lifecycle.configValues.fast).toBe("true");
  });

  it("keeps a subagent's config off the session", async () => {
    const sid = "child-config";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, {
      sessionUpdate: "config_option_update",
      childSessionId: "child",
      configOptions: [{ id: "model", name: "Model", currentValue: "opus", options: [] }],
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(getLifecycle(sid).configOptions).toEqual([]);
  });

  it("drops the requests of a subagent that stopped", async () => {
    const sid = "withdrawn";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://permission-request/${sid}`, { request_id: "p1", payload: { sessionId: "child" } });
    emit(`acp://permission-request/${sid}`, { request_id: "p2", payload: { sessionId: "root" } });
    emit(`acp://session-update/${sid}`, {
      sessionUpdate: "subagent_update",
      sessionId: "child",
      state: { state: "idle", stopReason: "cancelled" },
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(getLifecycle(sid).pendingRequests.map((r) => r.requestId)).toEqual(["p2"]);
  });

  it("queues requests that arrive together instead of replacing the first", async () => {
    const sid = "queued";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://permission-request/${sid}`, { request_id: "p1", payload: {} });
    emit(`acp://elicitation-request/${sid}`, { request_id: "e1", message: "Which?", payload: {} });
    // A reattach re-sends what is still unanswered.
    emit(`acp://permission-request/${sid}`, { request_id: "p1", payload: {} });

    const lifecycle = getLifecycle(sid);
    expect(lifecycle.pendingRequests.map((r) => [r.kind, r.requestId])).toEqual([
      ["permission", "p1"],
      ["elicitation", "e1"],
    ]);
    expect(shownRequest(lifecycle)?.requestId).toBe("p1");
    expect(shownRequest({ ...lifecycle, shownRequestId: "e1" })?.requestId).toBe("e1");
    expect(shownRequest({ ...lifecycle, shownRequestId: "gone" })?.requestId).toBe("p1");
  });

  it("drains again when the backend takes the session back, keeping what it had", async () => {
    const sid = "reattached";
    const unsubscribe = subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, chunk("before"));
    await vi.advanceTimersByTimeAsync(60);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(0);

    emit(`acp://session-attached/${sid}`, null);
    subscribeSession(sid, () => {});
    expect(drainAcpReplay).toHaveBeenCalledTimes(2);
    expect(getActivity(sid).items).toHaveLength(1);
  });

  it("is dropped on release although the session has not ended", async () => {
    const sid = "released";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, chunk("hi"));
    await vi.advanceTimersByTimeAsync(60);
    releaseSession(sid);
    await vi.advanceTimersByTimeAsync(0);

    expect(getActivity(sid).items).toHaveLength(0);
    expect(handlers.has(`acp://session-update/${sid}`)).toBe(false);
  });

  it("is dropped once the session ends with nothing watching", async () => {
    const sid = "ends";
    const unsubscribe = subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-update/${sid}`, chunk("hi"));
    await vi.advanceTimersByTimeAsync(60);
    unsubscribe();
    emit(`acp://session-ended/${sid}`, null);
    await vi.advanceTimersByTimeAsync(60);

    expect(getActivity(sid).items).toHaveLength(0);
  });

  it("puts a sign-in refusal at spawn in the transcript, where its Login button is", async () => {
    const sid = "refused";
    subscribeSession(sid, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emit(`acp://session-error/${sid}`, "auth_required");
    await vi.advanceTimersByTimeAsync(60);

    expect(getActivity(sid).items).toEqual([
      expect.objectContaining({
        type: "error",
        item: expect.objectContaining({ stopReason: "auth_required" }),
      }),
    ]);
  });
});
