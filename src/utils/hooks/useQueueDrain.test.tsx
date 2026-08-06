import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "@/types/bindings";

const execute = vi.hoisted(() => vi.fn<(task: Task) => Promise<void>>());
const drainReadyQueue = vi.hoisted(() => vi.fn<() => Promise<number[]>>());
/// Captures the listeners the hook registers so a test can fire the backend events itself.
const listeners = vi.hoisted(() => new Map<string, () => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

vi.mock("@/lib/tauri-utils", () => ({
  api: { drainReadyQueue: () => drainReadyQueue() },
}));

vi.mock("@/utils/hooks/useExecuteTask", () => ({
  useExecuteTask: () => ({ execute }),
}));

import { useQueueDrain } from "./useQueueDrain";

function makeTask(id: number): Task {
  return { id, title: `task ${id}`, status: "Queue" } as Task;
}

const tasks = [makeTask(1), makeTask(2), makeTask(3)];

/// Runs the debounce out and then lets the drain's promise chain settle. `waitFor` cannot be used
/// here — it polls on real timers, which never advance while these are faked.
async function settle() {
  await vi.advanceTimersByTimeAsync(500);
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function render(taskList: Task[] = tasks) {
  return renderHook(() =>
    useQueueDrain(7, "/tmp/demo", taskList, { type: "local" } as Parameters<
      typeof useQueueDrain
    >[3]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  execute.mockReset().mockResolvedValue(undefined);
  drainReadyQueue.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useQueueDrain", () => {
  /// A queue left full when the app closed would otherwise sit there until something happened to
  /// move a task — which, if nothing is running, is never.
  it("drains on mount", async () => {
    drainReadyQueue.mockResolvedValue([2]);
    render();

    await vi.advanceTimersByTimeAsync(500);

    expect(drainReadyQueue).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(tasks[1]);
  });

  it("drains when a slot frees or a task arrives", async () => {
    render();
    await vi.advanceTimersByTimeAsync(500);
    drainReadyQueue.mockClear();

    listeners.get("sessions-changed")?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(drainReadyQueue).toHaveBeenCalledTimes(1);

    listeners.get("tasks-changed")?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(drainReadyQueue).toHaveBeenCalledTimes(2);
  });

  /// Switching auto-mode on has to start work immediately. Without this the setting sits inert
  /// until a task happens to move, which is what made the switch look broken.
  it("drains when settings change", async () => {
    render();
    await vi.advanceTimersByTimeAsync(500);
    drainReadyQueue.mockClear();

    listeners.get("settings-changed")?.();
    await vi.advanceTimersByTimeAsync(500);

    expect(drainReadyQueue).toHaveBeenCalledTimes(1);
  });

  /// One transition emits several events. Draining per event would ask the backend the same
  /// question three times and race its own answers.
  it("collapses a burst of events into one drain", async () => {
    render();
    await vi.advanceTimersByTimeAsync(500);
    drainReadyQueue.mockClear();

    listeners.get("tasks-changed")?.();
    listeners.get("sessions-changed")?.();
    listeners.get("tasks-changed")?.();
    await vi.advanceTimersByTimeAsync(500);

    expect(drainReadyQueue).toHaveBeenCalledTimes(1);
  });

  /// The guard that matters: a second drain starting while the first is still spawning would be
  /// told the same slots are free, because claims are not written until each spawn begins.
  it("does not start a second drain while one is running", async () => {
    let releaseDrain: (ids: number[]) => void = () => {};
    drainReadyQueue.mockImplementation(
      () => new Promise<number[]>((resolve) => (releaseDrain = resolve)),
    );

    render();
    await vi.advanceTimersByTimeAsync(500);
    expect(drainReadyQueue).toHaveBeenCalledTimes(1);

    listeners.get("tasks-changed")?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(drainReadyQueue).toHaveBeenCalledTimes(1);

    releaseDrain([]);
    await vi.advanceTimersByTimeAsync(0);

    listeners.get("tasks-changed")?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(drainReadyQueue).toHaveBeenCalledTimes(2);
  });

  /// The ids were counted against the slots free when the drain ran, so each has to claim before
  /// the next starts. Firing them together is correct only until a claim fails.
  it("starts tasks one at a time", async () => {
    drainReadyQueue.mockResolvedValue([1, 2]);
    let inFlight = 0;
    let overlapped = false;
    execute.mockImplementation(async () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      await Promise.resolve();
      inFlight -= 1;
    });

    render();
    await settle();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(overlapped).toBe(false);
  });

  /// The task list can lag the backend by a render. Skipping is safe — the task keeps its place
  /// in the queue — but crashing on it would take the whole board down.
  it("skips an id it cannot find without failing the drain", async () => {
    drainReadyQueue.mockResolvedValue([99, 1]);
    render();

    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(tasks[0]);
  });

  it("does not drain without a project", async () => {
    renderHook(() =>
      useQueueDrain(null, "", tasks, { type: "local" } as Parameters<typeof useQueueDrain>[3]),
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(drainReadyQueue).not.toHaveBeenCalled();
  });
});
