import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHomeStore } from "@/store/homeStore";

const stopBackgroundServer = vi.fn();
vi.mock("@/lib/tauri-utils", () => ({ api: { stopBackgroundServer } }));

const { useStopBackgroundServerMutation } = await import("./automation.service");
const local = { type: "local" } as const;
const phase = () => useHomeStore.getState().phases.local;

function renderStop() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return renderHook(() => useStopBackgroundServerMutation(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  }).result;
}

describe("useStopBackgroundServerMutation", () => {
  beforeEach(() => useHomeStore.getState().setPhase("local", { kind: "up" }));

  it("shows stopping until the server is gone, then stopped", async () => {
    let finish!: () => void;
    stopBackgroundServer.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const result = renderStop();
    let stop!: Promise<unknown>;
    act(() => {
      stop = result.current.mutateAsync(local);
    });
    await vi.waitFor(() => expect(phase()).toEqual({ kind: "stopping" }));
    finish();
    await act(() => stop);
    expect(phase()).toEqual({ kind: "stopped" });
  });

  it("puts the panel back when the stop fails", async () => {
    stopBackgroundServer.mockRejectedValueOnce(new Error("no"));
    const result = renderStop();
    await act(() => expect(result.current.mutateAsync(local)).rejects.toThrow("no"));
    expect(phase()).toEqual({ kind: "up" });
  });
});
