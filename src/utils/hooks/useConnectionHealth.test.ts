import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri event API
const mockListeners: Record<string, ((event: { payload: unknown }) => void)[]> = {};
const mockUnlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    if (!mockListeners[event]) mockListeners[event] = [];
    mockListeners[event].push(handler);
    return Promise.resolve(mockUnlisten);
  }),
}));

function emitMockEvent(event: string, payload: unknown) {
  mockListeners[event]?.forEach((handler) => handler({ payload }));
}

import { useConnectionHealth } from "./useConnectionHealth";

describe("useConnectionHealth", () => {
  beforeEach(() => {
    // Clear all mock listeners between tests
    for (const key of Object.keys(mockListeners)) {
      delete mockListeners[key];
    }
    mockUnlisten.mockClear();
  });

  it("returns connected state initially", () => {
    const { result } = renderHook(() => useConnectionHealth(1));
    expect(result.current.state).toBe("connected");
    expect(result.current.attempt).toBe(0);
    expect(result.current.maxAttempts).toBe(5);
  });

  it("returns connected and registers no listeners when connectionId is null", () => {
    const { result } = renderHook(() => useConnectionHealth(null));
    expect(result.current.state).toBe("connected");
    // No listeners should have been registered
    expect(Object.keys(mockListeners).length).toBe(0);
  });

  it("transitions to lost state on ssh-connection-lost event", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    // Allow listeners to register
    await vi.waitFor(() => {
      expect(mockListeners["ssh-connection-lost"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-connection-lost", 42);
    });

    expect(result.current.state).toBe("lost");
  });

  it("transitions to reconnecting state with attempt info", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    await vi.waitFor(() => {
      expect(mockListeners["ssh-reconnecting"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-reconnecting", {
        connection_id: 42,
        attempt: 3,
        max_attempts: 5,
      });
    });

    expect(result.current.state).toBe("reconnecting");
    expect(result.current.attempt).toBe(3);
    expect(result.current.maxAttempts).toBe(5);
  });

  it("holds reconnecting state on ssh-reconnected, then connected on acp-sessions-restored", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    await vi.waitFor(() => {
      expect(mockListeners["ssh-connection-lost"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-connection-lost", 42);
    });
    expect(result.current.state).toBe("lost");

    act(() => {
      emitMockEvent("ssh-reconnected", 42);
    });
    // Backdrop stays up while ACP sessions restore
    expect(result.current.state).toBe("reconnecting");

    act(() => {
      emitMockEvent("acp-sessions-restored", 42);
    });
    expect(result.current.state).toBe("connected");
    expect(result.current.attempt).toBe(0);
  });

  it("transitions to failed state on ssh-connection-failed event", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    await vi.waitFor(() => {
      expect(mockListeners["ssh-connection-failed"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-connection-failed", 42);
    });

    expect(result.current.state).toBe("failed");
  });

  it("ignores events for different connection_id", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    await vi.waitFor(() => {
      expect(mockListeners["ssh-connection-lost"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-connection-lost", 99);
    });

    expect(result.current.state).toBe("connected");
  });

  it("dismiss resets state to connected", async () => {
    const { result } = renderHook(() => useConnectionHealth(42));

    await vi.waitFor(() => {
      expect(mockListeners["ssh-connection-failed"]?.length).toBeGreaterThan(0);
    });

    act(() => {
      emitMockEvent("ssh-connection-failed", 42);
    });
    expect(result.current.state).toBe("failed");

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.state).toBe("connected");
  });
});
