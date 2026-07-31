import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockListeners: Record<string, ((event: { payload: unknown }) => void)[]> = {};
const mockUnlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    if (!mockListeners[event]) mockListeners[event] = [];
    mockListeners[event].push(handler);
    return Promise.resolve(mockUnlisten);
  }),
}));

import { useFileTransfer, transferTooltip } from "./useFileTransfer";

/// A promise the test resolves by hand, so a transfer can be held open across timer advances.
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

describe("useFileTransfer", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockListeners)) delete mockListeners[key];
    mockUnlisten.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing for a transfer that finishes before the appear delay", async () => {
    const { result } = renderHook(() => useFileTransfer());
    const work = deferred<void>();

    act(() => {
      void result.current.run({
        transferId: "fast",
        reportsProgress: false,
        action: () => work.promise,
      });
    });
    // Immediately busy for the purposes of disabling the button...
    expect(result.current.pending).toBe(true);
    // ...but nothing has been rendered yet.
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      work.settle();
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.state.status).toBe("idle");
    expect(result.current.pending).toBe(false);
  });

  it("falls back to an indeterminate ring when the transport reports no bytes", async () => {
    const { result } = renderHook(() => useFileTransfer());
    const work = deferred<void>();

    act(() => {
      void result.current.run({
        transferId: "docker",
        reportsProgress: false,
        action: () => work.promise,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.state).toEqual({ status: "busy", progress: null });
    expect(transferTooltip(result.current.state, "idle")).toBe("Copying…");

    await act(async () => {
      work.settle();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("tracks byte counts when the transport reports them", async () => {
    const { result } = renderHook(() => useFileTransfer());
    const work = deferred<void>();

    act(() => {
      void result.current.run({
        transferId: "ssh",
        reportsProgress: true,
        action: () => work.promise,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    act(() => {
      mockListeners["sftp://transfer-progress/ssh"]?.forEach((handler) =>
        handler({ payload: { bytes_transferred: 25, total_bytes: 100 } }),
      );
    });

    expect(result.current.state).toEqual({ status: "busy", progress: 25 });
    expect(transferTooltip(result.current.state, "idle")).toBe("Copying — 25%");

    await act(async () => {
      work.settle();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockUnlisten).toHaveBeenCalled();
  });

  it("keeps a failure on screen with the reason the backend gave", async () => {
    const { result } = renderHook(() => useFileTransfer());

    await act(async () => {
      await result.current.run({
        transferId: "boom",
        reportsProgress: false,
        action: () => Promise.reject(new Error("No such container")),
      });
    });

    expect(result.current.state).toEqual({ status: "error", detail: "No such container" });

    // Unlike the confirmation, this does not time out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.state.status).toBe("error");
  });

  it("confirms where a download landed, then returns to rest", async () => {
    const { result } = renderHook(() => useFileTransfer());

    await act(async () => {
      await result.current.run({
        transferId: "dl",
        reportsProgress: false,
        action: () => Promise.resolve("/home/me/Downloads/report.pdf"),
        describeDone: (dest) => `Saved to ${dest}`,
      });
    });

    expect(result.current.state).toEqual({
      status: "done",
      detail: "Saved to /home/me/Downloads/report.pdf",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.state.status).toBe("idle");
  });

  it("stays quiet when the action reports nothing worth confirming", async () => {
    const { result } = renderHook(() => useFileTransfer());

    // What a dismissed folder picker looks like: succeeded, but nothing was copied.
    await act(async () => {
      await result.current.run({
        transferId: "cancelled",
        reportsProgress: false,
        action: () => Promise.resolve(null),
        describeDone: (dest) => (dest === null ? null : `Saved to ${dest}`),
      });
    });

    expect(result.current.state.status).toBe("idle");
  });

  it("ignores a second action while one is already running", async () => {
    const { result } = renderHook(() => useFileTransfer());
    const first = deferred<void>();
    const second = vi.fn(() => Promise.resolve());

    act(() => {
      void result.current.run({
        transferId: "first",
        reportsProgress: false,
        action: () => first.promise,
      });
    });
    act(() => {
      void result.current.run({ transferId: "second", reportsProgress: false, action: second });
    });

    expect(second).not.toHaveBeenCalled();

    await act(async () => {
      first.settle();
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
