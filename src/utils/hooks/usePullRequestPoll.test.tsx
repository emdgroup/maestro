import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const reconcilePullRequests = vi.hoisted(() => vi.fn<() => Promise<number[]>>());
const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri-utils", () => ({
  api: { reconcilePullRequests: () => reconcilePullRequests() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

import { usePullRequestPoll } from "./usePullRequestPoll";

/// Lets the sweep's promise chain settle. `waitFor` cannot be used — it polls on real timers,
/// which never advance while these are faked.
async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  reconcilePullRequests.mockReset().mockResolvedValue([]);
  invalidateQueries.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePullRequestPoll", () => {
  // This is the whole of offline reconciliation: the app was not running when the PR merged, so
  // the sweep on mount is what finds out.
  it("sweeps as soon as a project is open", async () => {
    renderHook(() => usePullRequestPoll(7));
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a project", async () => {
    renderHook(() => usePullRequestPoll(null));
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  it("keeps sweeping on a timer", async () => {
    renderHook(() => usePullRequestPoll(7));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("refreshes the board only when something actually changed", async () => {
    renderHook(() => usePullRequestPoll(7));
    await settle();

    expect(invalidateQueries).not.toHaveBeenCalled();

    reconcilePullRequests.mockResolvedValue([12]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(invalidateQueries).toHaveBeenCalled();
  });

  // A rate limit or a dropped connection means "ask again in three minutes", not "this task is
  // broken". The hook must survive it and keep its timer.
  it("survives a forge that will not answer", async () => {
    reconcilePullRequests.mockRejectedValue(new Error("403 rate limited"));
    renderHook(() => usePullRequestPoll(7));
    await settle();

    reconcilePullRequests.mockReset().mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping once the view is gone", async () => {
    const { unmount } = renderHook(() => usePullRequestPoll(7));
    await settle();
    reconcilePullRequests.mockClear();

    unmount();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });
});
