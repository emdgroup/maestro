import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * Every registration the hook makes, in order, so a test can count them as well as fire them.
 * A `Map` keyed on the event name would hide the bug this file exists to prevent — N components
 * each registering the same event looked identical to one component registering it once.
 */
const registrations = vi.hoisted(
  () => [] as Array<{ event: string; handler: (e: unknown) => void; unlisten: () => void }>,
);
const unlistened = vi.hoisted(() => [] as string[]);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: unknown) => void) => {
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
import { promptQueryKeys } from "./prompt.service";
import { loopQueryKeys } from "./loop.service";
import { projectQueryKeys } from "./project.service";
import { settingsQueryKeys } from "./settings.service";
import { useTauriEvent } from "./tauri-events";

// The module is mocked above for `useQueryClient`; the key matcher is wanted for real.
const { partialMatchKey } =
  await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

/** `listen` resolves on a microtask, so nothing is registered until the queue drains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const eventsRegistered = () => registrations.map((r) => r.event);

function fire(event: string, payload: unknown = { project_id: null }) {
  for (const registration of registrations) {
    if (registration.event === event) registration.handler({ payload });
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

    expect(eventsRegistered()).toEqual([
      "tasks-changed",
      "worktrees-changed",
      "automations-changed",
      "templates-changed",
      "prompts-changed",
      "automation-run-changed",
      "project-locks-changed",
      "sessions-changed",
      "settings-changed",
    ]);
  });

  it("invalidates the task list on tasks-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: taskQueryKeys.lists() });
  });

  it("invalidates that project's per-task queries on tasks-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed", { project_id: 7 });

    for (const kind of ["attachments", "commitMessage"]) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["tasks", kind, 7] });
    }
    // The prefix matches the keys the hooks use.
    expect(taskQueryKeys.attachments(7, 3).slice(0, 3)).toEqual(["tasks", "attachments", 7]);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["tasks", "comments", 7] });
  });

  /** The loop rows moved under one prefix, ids before the kind; this pins what that prefix reaches. */
  it("refetches the project's loop rows, and nothing of another project or branch", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed", { project_id: 7 });

    const prefixes = invalidateQueries.mock.calls.map(([filter]) => filter.queryKey as unknown[]);
    const reached = (key: readonly unknown[]) =>
      prefixes.some((prefix) => partialMatchKey(key, prefix));
    expect(reached(loopQueryKeys.checks(7, 3))).toBe(true);
    expect(reached(loopQueryKeys.iterations(7, 3))).toBe(true);
    expect(reached(loopQueryKeys.notes(7, 3))).toBe(true);
    expect(reached(loopQueryKeys.checks(8, 3))).toBe(false);
    expect(reached(loopQueryKeys.branchFiles(7, "main"))).toBe(false);
  });

  it("invalidates every project's per-task queries when tasks-changed names none", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed", { project_id: null });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["tasks", "attachments"] });
  });

  it("ignores another project's tasks-changed and worktrees-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("tasks-changed", { project_id: 8 });
    fire("worktrees-changed", { project_id: 8 });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: taskQueryKeys.lists() });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: worktreeQueryKeys.base });
    // Home's tiles and the host's agent slots are not this project's alone.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: projectQueryKeys.home() });

    fire("tasks-changed", { project_id: 7 });
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

  it("refetches only the prompt collection that changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("prompts-changed", { collection: "shared", project_id: null });
    expect(invalidateQueries).toHaveBeenLastCalledWith({ queryKey: promptQueryKeys.shared() });

    fire("prompts-changed", { collection: "project", project_id: 7 });
    expect(invalidateQueries).toHaveBeenLastCalledWith({ queryKey: promptQueryKeys.project(7) });

    // A project the app could not name: every project's list, never the shared one.
    fire("prompts-changed", { collection: "project", project_id: null });
    expect(invalidateQueries).toHaveBeenLastCalledWith({ queryKey: promptQueryKeys.projects() });
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
  });

  /**
   * The sessions key is per project, so there is nothing to ask about until one is open. The other
   * two invalidate prefixes and stay armed through the project picker.
   */
  it("does not subscribe to sessions before a project is open", async () => {
    renderHook(() => useServerEventSync(undefined));
    await flush();

    expect(eventsRegistered()).toEqual([
      "tasks-changed",
      "worktrees-changed",
      "automations-changed",
      "templates-changed",
      "prompts-changed",
      "automation-run-changed",
      "project-locks-changed",
    ]);
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

    expect(unlistened).toEqual([
      "tasks-changed",
      "worktrees-changed",
      "automations-changed",
      "templates-changed",
      "prompts-changed",
      "automation-run-changed",
      "project-locks-changed",
      "sessions-changed",
      "settings-changed",
    ]);
  });

  /**
   * `listen` is async, so an unmount can land before it settles. Without the cancelled flag the
   * cleanup has nothing to call and the listener outlives the component forever.
   */
  it("unsubscribes a listener that resolved after unmount", async () => {
    const { unmount } = renderHook(() => useServerEventSync(7));

    unmount();
    await flush();

    expect(unlistened).toEqual([
      "tasks-changed",
      "worktrees-changed",
      "automations-changed",
      "templates-changed",
      "prompts-changed",
      "automation-run-changed",
      "project-locks-changed",
      "sessions-changed",
      "settings-changed",
    ]);
  });
});

describe("useServerEventSync, project settings and capacity", () => {
  it("re-reads the open project's auto mode and loop cap on settings-changed", async () => {
    renderHook(() => useServerEventSync(7));
    await flush();

    fire("settings-changed");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: settingsQueryKeys.autoMode(7) });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: settingsQueryKeys.loopWaitCap(7) });
  });

  /** One transition emits several events; the capacity is asked once for all of them. */
  it("answers a burst of changes with one capacity refetch", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useServerEventSync(7));
      await flush();

      fire("tasks-changed", { project_id: 8 });
      fire("sessions-changed");
      fire("settings-changed");
      const capacity = () =>
        invalidateQueries.mock.calls.filter(
          ([filter]) =>
            JSON.stringify(filter.queryKey) === JSON.stringify(executionQueryKeys.queueCapacity(7)),
        ).length;
      expect(capacity()).toBe(0);

      vi.advanceTimersByTime(400);
      expect(capacity()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useTauriEvent", () => {
  it("hands the payload to the newest handler", async () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useTauriEvent<string>("ping", (payload) => seen.push(`${tag}:${payload}`)),
      { initialProps: { tag: "a" } },
    );
    await flush();
    rerender({ tag: "b" });

    fire("ping", "x");

    expect(seen).toEqual(["b:x"]);
    expect(eventsRegistered()).toEqual(["ping"]);
  });

  it("subscribes to nothing for a null name", async () => {
    renderHook(() => useTauriEvent(null, () => {}));
    await flush();

    expect(eventsRegistered()).toEqual([]);
  });

  /** The leak `AgentAuthModal` had: closed before `listen` settled, and never unsubscribed. */
  it("unsubscribes a listener that resolved after unmount", async () => {
    const { unmount } = renderHook(() => useTauriEvent("ping", () => {}));
    unmount();
    await flush();

    expect(unlistened).toEqual(["ping"]);
  });
});
