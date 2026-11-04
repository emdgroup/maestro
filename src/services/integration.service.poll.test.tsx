import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const reconcilePullRequests = vi.hoisted(() => vi.fn<() => Promise<number[]>>());
const invalidateQueries = vi.hoisted(() => vi.fn());
// Stable, as a real `QueryClient` is: a fresh object per render would re-run the sweep's effect.
const queryClient = vi.hoisted(() => ({ invalidateQueries }));

vi.mock("@/lib/tauri-utils", () => ({
  api: { reconcilePullRequests: () => reconcilePullRequests() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClient,
}));

import type { Task } from "@/types/bindings";
import { usePullRequestPoll, sweepInterval } from "./integration.service";

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
    expect(sweepInterval(true, 5, false)).toBe(6_000);
  });

  it("drops back to the steady rate once the verdict lands", () => {
    expect(sweepInterval(false, 5, false)).toBe(3 * 60 * 1000);
  });

  // A repository with no CI is unreported forever. Without the bound it would poll the forge every
  // six seconds for the life of the session.
  it("drops back to the steady rate once the burst is spent", () => {
    expect(sweepInterval(true, 0, false)).toBe(3 * 60 * 1000);
  });

  it("sweeps every minute while the user is on the board", () => {
    expect(sweepInterval(false, 5, true)).toBe(60 * 1000);
  });
});

describe("usePullRequestPoll", () => {
  // This is the whole of offline reconciliation: the app was not running when the PR merged, so
  // the sweep on mount is what finds out.
  it("sweeps as soon as a project is open", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a project", async () => {
    renderHook(() => usePullRequestPoll(null, NO_TASKS, false));
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  it("keeps sweeping on a timer", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("refreshes the board only when something actually changed", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
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
    renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
    await settle();

    reconcilePullRequests.mockReset().mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping once the view is gone", async () => {
    const { unmount } = renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
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
    const { rerender } = renderHook(({ tasks }) => usePullRequestPoll(7, tasks, false), {
      initialProps: { tasks: NO_TASKS },
    });
    await settle();
    reconcilePullRequests.mockClear();

    rerender({ tasks: [awaitingMerge(1)] });
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("then keeps asking every few seconds until the forge reports", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1)], false));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  // A forge that never reports CI must not be polled every six seconds forever.
  it("gives up bursting after a bounded number of tries", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1)], false));
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
    renderHook(() => usePullRequestPoll(7, [archived], false));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  // The burst exists to resolve one question. Once every open pull request has an answer, asking
  // again every six seconds buys nothing.
  it("does not burst for a pull request the forge has already answered", async () => {
    renderHook(() => usePullRequestPoll(7, [awaitingMerge(1, "Passing")], false));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });
});

describe("usePullRequestPoll on the board", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sweeps every minute while the board has focus", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, true));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("keeps the slow rate on the board while the window is in the background", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    renderHook(() => usePullRequestPoll(7, NO_TASKS, true));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  it("sweeps at once on arriving at the board, and not on leaving it", async () => {
    const { rerender } = renderHook(({ onBoard }) => usePullRequestPoll(7, NO_TASKS, onBoard), {
      initialProps: { onBoard: false },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    reconcilePullRequests.mockClear();

    rerender({ onBoard: true });
    await settle();
    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);

    rerender({ onBoard: false });
    await settle();
    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("sweeps at once when the window comes back to the board", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, true));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    reconcilePullRequests.mockClear();

    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  it("ignores the window coming back to another tab", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, false));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    reconcilePullRequests.mockClear();

    window.dispatchEvent(new Event("focus"));
    await settle();

    expect(reconcilePullRequests).not.toHaveBeenCalled();
  });

  // A wake replaces the pending timer rather than adding a second loop beside it.
  it("does not leave two timers running after a wake", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, true));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);

    window.dispatchEvent(new Event("focus"));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await settle();

    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });

  // Alt-tabbing back and forth must not cost a forge request per open pull request on every switch.
  it("wakes at most once every five seconds", async () => {
    renderHook(() => usePullRequestPoll(7, NO_TASKS, true));
    await settle();
    reconcilePullRequests.mockClear();

    await vi.advanceTimersByTimeAsync(4_000);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(reconcilePullRequests).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    window.dispatchEvent(new Event("focus"));
    await settle();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(reconcilePullRequests).toHaveBeenCalledTimes(1);
  });
});
