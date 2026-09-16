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

import type { Task } from "@/types/bindings";
import { usePullRequestPoll, sweepInterval } from "./usePullRequestPoll";

const NO_TASKS: Task[] = [];

/** Only the four fields the hook reads; the rest of a `Task` is irrelevant to the sweep. */
function awaitingMerge(id: number, ci: Task["pull_request_ci"] = null): Task {
  return {
    id,
    phase: "AwaitingMerge",
    pull_request_number: 100 + id,
    pull_request_ci: ci,
  } as Task;
}

/**
 * Lets the sweep's promise chain settle. `waitFor` cannot be used — it polls on real timers,
 * which never advance while these are faked.
 */
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

describe("sweepInterval", () => {
  it("bursts while a pull request has told us nothing yet", () => {
    expect(sweepInterval(true, 5)).toBe(6_000);
  });

  it("drops back to the steady rate once the verdict lands", () => {
    expect(sweepInterval(false, 5)).toBe(3 * 60 * 1000);
  });

  // A repository with no CI is unreported forever. Without the bound it would poll the forge every
  // six seconds for the life of the session.
  it("drops back to the steady rate once the burst is spent", () => {
    expect(sweepInterval(true, 0)).toBe(3 * 60 * 1000);
  });
});

describe("usePullRequestPoll", () => {
  // This is the whole of offline reconciliation: the app was not running when the PR merged, so
  // the sweep on mount is what finds out.
  it("sweeps as soon as a project is open", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS));
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a project", async () => {
    renderHook(() => usePullRequestPoll(null, NO_TASKS));
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  it("keeps sweeping on a timer", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("refreshes the board only when something actually changed", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS));
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
    renderHook(() => usePullRequestPoll(7, NO_TASKS));
    await settle();

    reconcilePullRequests.mockReset().mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping once the view is gone", async () => {
    const { unmount } = renderHook(() => usePullRequestPoll(7, NO_TASKS));
    await settle();
    reconcilePullRequests.mockClear();

    unmount();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  // The reported delay: approving with "open a pull request" writes the number and a NULL CI, so
  // waiting for the next three-minute tick is waiting three minutes to learn anything about it.
  it("sweeps at once when a pull request appears", async () => {
    const { rerender } = renderHook(({ tasks }) => usePullRequestPoll(7, tasks), {
      initialProps: { tasks: NO_TASKS },
    });
    await settle();
    reconcilePullRequests.mockClear();

    rerender({ tasks: [awaitingMerge(1)] });
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("then keeps asking every few seconds until the forge reports", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1)]));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  // A forge that never reports CI must not be polled every six seconds forever.
  it("gives up bursting after a bounded number of tries", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1)]));
    await settle();

    await vi.advanceTimersByTimeAsync(5 * 6_000);
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(reconcilePullRequests).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();
    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  // `get_tasks` returns archived tasks and reconcile's SQL skips them, so an archived task with a
  // NULL CI is a question the backend will never answer — and it would keep the burst armed for
  // the whole session.
  it("ignores a pull request on an archived task", async () => {
    const archived = { ...awaitingMerge(1), archived_at: "2026-09-16T00:00:00Z" } as Task;
    renderHook(() => usePullRequestPoll(7, [archived]));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  // The burst exists to resolve one question. Once every open pull request has an answer, asking
  // again every six seconds buys nothing.
  it("does not burst for a pull request the forge has already answered", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1, "Passing")]));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });
});
