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

import { getActivity, getLifecycle, subscribeSession } from "./sessionRuntime";

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
    expect(getLifecycle(sid).pendingPermission?.requestId).toBe("r1");
    expect(drainAcpReplay).toHaveBeenCalledTimes(1);
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
});
