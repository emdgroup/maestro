import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { taskQueryKeys } from "@/services/task.service";
import { worktreeQueryKeys } from "@/services/worktree.service";
import { executionQueryKeys } from "@/services/execution.service";

/**
 * The backend's three "something changed" events, subscribed once for the whole app.
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

    const subscribe = (event: string, invalidate: () => void) => {
      void listen(event, invalidate).then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    subscribe("tasks-changed", () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    });

    subscribe("worktrees-changed", () => {
      void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
    });

    // Keyed on the project, so there is nothing to listen for until one is open.
    if (projectId !== undefined) {
      subscribe("sessions-changed", () => {
        void queryClient.invalidateQueries({
          queryKey: executionQueryKeys.activeSessions(projectId),
        });
      });
    }

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [queryClient, projectId]);
}
