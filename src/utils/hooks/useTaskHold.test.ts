import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const holdTask = vi.hoisted(() => vi.fn<(taskId: number) => Promise<null>>());
const releaseTaskHold = vi.hoisted(() => vi.fn<(taskId: number) => Promise<null>>());

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    holdTask: (taskId: number) => holdTask(taskId),
    releaseTaskHold: (taskId: number) => releaseTaskHold(taskId),
  },
}));

import { useTaskHold } from "./useTaskHold";

beforeEach(() => {
  vi.useFakeTimers();
  holdTask.mockReset().mockResolvedValue(null);
  releaseTaskHold.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTaskHold", () => {
  it("holds the task as soon as the interaction starts", () => {
    renderHook(() => useTaskHold(4, true));

    expect(holdTask).toHaveBeenCalledWith(4);
  });

  /// The backend expires a hold nobody renews, which is what frees a task whose window went away.
  /// A client that held once and stopped would have the task taken back mid-drag.
  it("keeps renewing while the interaction lasts", async () => {
    renderHook(() => useTaskHold(4, true));
    holdTask.mockClear();

    await vi.advanceTimersByTimeAsync(11_000);

    expect(holdTask.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("releases when the interaction ends", () => {
    const { rerender } = renderHook(({ active }) => useTaskHold(4, active), {
      initialProps: { active: true },
    });

    rerender({ active: false });

    expect(releaseTaskHold).toHaveBeenCalledWith(4);
  });

  it("releases on unmount", () => {
    const { unmount } = renderHook(() => useTaskHold(4, true));

    unmount();

    expect(releaseTaskHold).toHaveBeenCalledWith(4);
  });

  /// Every card on the board mounts this. Holding one that is not being interacted with would
  /// hand the whole queue to the scheduler's skip list.
  it("does nothing while inactive", async () => {
    renderHook(() => useTaskHold(4, false));

    await vi.advanceTimersByTimeAsync(11_000);

    expect(holdTask).not.toHaveBeenCalled();
    expect(releaseTaskHold).not.toHaveBeenCalled();
  });

  it("does nothing without a task", () => {
    renderHook(() => useTaskHold(null, true));

    expect(holdTask).not.toHaveBeenCalled();
  });
});
