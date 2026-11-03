import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { concernsProject, taskQueryKeys } from "@/services/task.service";
import { loopQueryKeys } from "@/services/loop.service";
import { worktreeQueryKeys } from "@/services/worktree.service";
import { executionQueryKeys } from "@/services/execution.service";
import { automationQueryKeys } from "@/services/automation.service";
import { templateQueryKeys } from "@/services/template.service";
import { promptQueryKeys } from "@/services/prompt.service";
import { projectQueryKeys } from "@/services/project.service";
import { settingsQueryKeys } from "@/services/settings.service";

/**
 * One transition emits several of the events the queue capacity answers to, and answering each
 * separately means several `get_queue_capacity` calls for one change.
 */
const CAPACITY_DEBOUNCE_MS = 400;

/**
 * The backend's "something changed" events, subscribed once for the whole app.
 *
 * These lived inside `useTasksQuery`, `useWorktreesQuery` and `useActiveSessionsQuery`, so every
 * component calling one registered a listener of its own: a board of N cards held 2N native
 * subscriptions and turned a single `worktrees-changed` into N invalidations of the same prefix.
 * Mounted once from `App`, which is above every consumer of those hooks.
 *
 * Invalidation only — the queries themselves decide what to refetch and when. A listener here must
 * stay cheap enough to run while the user is on any tab, because it does.
 */
export function useServerEventSync(projectId: number | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // `listen` resolves asynchronously, so an unmount before it settles has no unlisten to call.
    // The flag is what makes that case unsubscribe late rather than never.
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const invalidate = (queryKey: readonly unknown[]) =>
      void queryClient.invalidateQueries({ queryKey });

    // One native listener per event, however many caches it refreshes.
    type Payload = { project_id?: number | null; collection?: "shared" | "project" };
    const handlers = new Map<string, Array<(payload: Payload) => void>>();
    // `tasks-changed` and `worktrees-changed` name the project they concern; another project's
    // change is not this window's to refetch.
    const on = (event: string, handle: (payload: Payload) => void, projectScoped = false) => {
      const list = handlers.get(event) ?? [];
      list.push((payload) => {
        if (!projectScoped || concernsProject(payload, projectId)) handle(payload);
      });
      handlers.set(event, list);
    };

    // The open task's own queries too, so an edit from another machine reaches its detail modal.
    // Comments have their own event.
    on(
      "tasks-changed",
      (payload) => {
        invalidate(taskQueryKeys.lists());
        // Each prefix takes the project id next, so naming it narrows the refetch to that project.
        const id = payload.project_id ?? null;
        const prefixes = [
          taskQueryKeys.attachmentsAll(),
          taskQueryKeys.commitMessagesAll(),
          loopQueryKeys.base,
        ];
        for (const queryKey of prefixes) invalidate(id === null ? queryKey : [...queryKey, id]);
      },
      true,
    );

    on("worktrees-changed", () => invalidate(worktreeQueryKeys.base), true);

    // An agent changed them through Maestro's MCP tools, with no mutation here to invalidate.
    on("automations-changed", () => invalidate(automationQueryKeys.base));

    on("templates-changed", () => invalidate(templateQueryKeys.list()));

    // `collection` says which one changed. A project's push with no `project_id` names a path this
    // app could not match to a project, so every project's list is refetched rather than none.
    on("prompts-changed", (payload) => {
      const id = payload.project_id ?? null;
      invalidate(
        payload.collection === "shared"
          ? promptQueryKeys.shared()
          : id === null
            ? promptQueryKeys.projects()
            : promptQueryKeys.project(id),
      );
    });

    // Home's summaries, whichever server said so: a task, a run or a lock anywhere moves a tile.
    for (const event of ["tasks-changed", "automation-run-changed", "project-locks-changed"]) {
      on(event, () => invalidate(projectQueryKeys.home()));
    }

    let capacityTimer: ReturnType<typeof setTimeout> | undefined;
    // Keyed on the project, so there is nothing to listen for until one is open.
    if (projectId !== undefined) {
      on("sessions-changed", () => invalidate(executionQueryKeys.activeSessions(projectId)));

      // Kept by the project's daemon and shared by every window on it.
      on("settings-changed", () => {
        invalidate(settingsQueryKeys.autoMode(projectId));
        invalidate(settingsQueryKeys.loopWaitCap(projectId));
      });

      // The agent slots are the host's, which other projects share, so any project's change can
      // move them. One transition emits several of these, and `tasks-changed` alone fires on
      // every permission prompt and every answer to one, so they are answered once, together.
      for (const event of ["tasks-changed", "sessions-changed", "settings-changed"]) {
        on(event, () => {
          clearTimeout(capacityTimer);
          capacityTimer = setTimeout(
            () => invalidate(executionQueryKeys.queueCapacity(projectId)),
            CAPACITY_DEBOUNCE_MS,
          );
        });
      }
    }

    for (const [event, list] of handlers) {
      void listen(event, ({ payload }) => {
        for (const handle of list) handle((payload ?? {}) as Payload);
      }).then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    return () => {
      cancelled = true;
      clearTimeout(capacityTimer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [queryClient, projectId]);
}

/**
 * Subscribe a component to one backend event while it is mounted, or until `name` changes. A null
 * `name` subscribes to nothing. The newest `handler` is the one called, so it needs no memoising.
 *
 * Cancel-safe like `useServerEventSync`: `listen` resolves later, so an unmount before it does
 * unsubscribes as soon as it can rather than never.
 */
export function useTauriEvent<T>(name: string | null, handler: (payload: T) => void) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (name === null) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<T>(name, (event) => handlerRef.current(event.payload)).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [name]);
}
