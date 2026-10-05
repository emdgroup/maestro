import { describe, it, expect, vi, beforeEach } from "vitest";
import { useHomeStore } from "@/store/homeStore";

const stopBackgroundServer = vi.fn();
const preflightConnection = vi.fn();
vi.mock("@/lib/tauri-utils", () => ({ api: { stopBackgroundServer } }));
vi.mock("@/types/bindings", () => ({ commands: { preflightConnection } }));

const { restartServer, stopServer } = await import("./useConnectionActions");
const local = { type: "local" } as const;
const phase = () => useHomeStore.getState().phases.local;

describe("stopping and starting the server", () => {
  beforeEach(() => useHomeStore.getState().setPhase("local", { kind: "up" }));

  it("shows stopping until the server is gone, then stopped", async () => {
    let finish!: () => void;
    stopBackgroundServer.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const stop = stopServer(local);
    expect(phase()).toEqual({ kind: "stopping" });
    finish();
    await stop;
    expect(phase()).toEqual({ kind: "stopped" });
  });

  it("puts the panel back when the stop fails", async () => {
    stopBackgroundServer.mockRejectedValueOnce("no");
    await expect(stopServer(local)).rejects.toBe("no");
    expect(phase()).toEqual({ kind: "up" });
  });

  it("restarting reads as starting, not connecting", async () => {
    stopBackgroundServer.mockResolvedValueOnce(undefined);
    let answer!: (value: unknown) => void;
    preflightConnection.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const restart = restartServer(local);
    await vi.waitFor(() => expect(phase()).toMatchObject({ kind: "connecting", starting: true }));
    answer({ status: "error", error: "x" });
    await restart;
  });
});
