import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * Every registration the hook makes, in order, so a test can count them as well as fire them.
 * A `Map` keyed on the event name would hide the bug this file exists to prevent — N components
 * each registering the same event looked identical to one component registering it once.
 */
const registrations = vi.hoisted(
  () => [] as Array<{ event: string; handler: () => void; unlisten: () => void }>,
);
const unlistened = vi.hoisted(() => [] as string[]);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: () => void) => {
    const unlisten = () => unlistened.push(event);
    registrations.push({ event, handler, unlisten });
    return Promise.resolve(unlisten);
  },
}));

const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

import { useServerEventSync } from "./tauri-events";
import { taskQueryKeys } from "./task.service";
import { worktreeQueryKeys } from "./worktree.service";
import { executionQueryKeys } from "./execution.service";

/** `listen` resolves on a microtask, so nothing is registered until the queue drains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const eventsRegistered = () => registrations.map((r) => r.event);

function fire(event: string) {
  for (const registration of registrations) {
    if (registration.event === event) registration.handler();
  }
}

beforeEach(() => {
  registrations.length = 0;
  unlistened.length = 0;
  invalidateQueries.mockClear();
});

describe("useServerEventSync", () => {
  it("subscribes to each backend event exactly once", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    expect(eventsRegistered()).toEqual(["tasks-changed", "worktrees-changed", "sessions-changed"]);
  });

  /**
   * The point of the hook. Before it, each of these lived inside a list query hook that a board of
   * N cards called N times, so one event became N invalidations of the same prefix.
   */
  it("registers one listener per event however many consumers exist", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("worktrees-changed");

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("invalidates the task list on tasks-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: taskQueryKeys.lists() });
  });

  it("invalidates the whole worktree prefix on worktrees-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("worktrees-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: worktreeQueryKeys.base });
  });

  it("invalidates the open project's sessions on sessions-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("sessions-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: executionQueryKeys.activeSessions(7),
    });
  });

  /**
   * The sessions key is per project, so there is nothing to ask about until one is open. The other
   * two invalidate prefixes and stay armed through the project picker.
   */
  it("does not subscribe to sessions before a project is open", async () => {
    renderHook(() => useServerEventSync(undefined));
    await flush();

    expect(eventsRegistered()).toEqual(["tasks-changed", "worktrees-changed"]);
  });

  it("re-subscribes sessions against the new project when it changes", async () => {
    const { rerender } = renderHook(({ id }: { id: number }) => useServerEventSync(id), {
      initialProps: { id: 7 },
    });
    await flush();
    registrations.length = 0;

    rerender({ id: 9 });
    await flush();
    fire("sessions-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: executionQueryKeys.activeSessions(9),
    });
  });

  it("unsubscribes everything on unmount", async () => {
    const { unmount } = renderHook(() => useServerEventSync(7));
    await flush();

    unmount();

    expect(unlistened).toEqual(["tasks-changed", "worktrees-changed", "sessions-changed"]);
  });

  /**
   * `listen` is async, so an unmount can land before it settles. Without the cancelled flag the
   * cleanup has nothing to call and the listener outlives the component forever.
   */
  it("unsubscribes a listener that resolved after unmount", async () => {
    const { unmount } = renderHook(() => useServerEventSync(7));

    unmount();
    await flush();

    expect(unlistened).toEqual(["tasks-changed", "worktrees-changed", "sessions-changed"]);
  });
});
