import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { concernsProject, taskQueryKeys } from "@/services/task.service";
import { worktreeQueryKeys } from "@/services/worktree.service";
import { executionQueryKeys } from "@/services/execution.service";
import { automationQueryKeys } from "@/services/automation.service";
import { templateQueryKeys } from "@/services/template.service";
import { promptQueryKeys } from "@/services/prompt.service";

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

    // `tasks-changed` and `worktrees-changed` name the project they concern; another project's
    // change is not this window's to refetch.
    const subscribe = (event: string, invalidate: () => void, projectScoped = false) => {
      const handler = ({ payload }: { payload: unknown }) => {
        if (!projectScoped || concernsProject(payload as { project_id?: number | null }, projectId))
          invalidate();
      };
      void listen(event, handler).then((unlisten) => {
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      });
    };

    subscribe(
      "tasks-changed",
      () => {
        void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
      },
      true,
    );

    subscribe(
      "worktrees-changed",
      () => {
        void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
      },
      true,
    );

    // An agent changed them through Maestro's MCP tools, with no mutation here to invalidate.
    subscribe("automations-changed", () => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKeys.base });
    });

    subscribe("templates-changed", () => {
      void queryClient.invalidateQueries({ queryKey: templateQueryKeys.list });
    });

    subscribe("prompts-changed", () => {
      void queryClient.invalidateQueries({ queryKey: promptQueryKeys.base });
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
