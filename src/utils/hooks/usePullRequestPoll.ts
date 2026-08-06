import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { taskQueryKeys } from "@/services/task.service";

/// Long enough that a repository full of open pull requests does not become a rate-limit problem,
/// short enough that a merge landed over coffee is on the board when the user looks back.
const POLL_MS = 3 * 60 * 1000;

/**
 * Asks the forge what became of the pull requests this project is waiting on.
 *
 * The sweep on mount is what covers the app not running when a pull request merged, and it needs
 * no separate mechanism: the backend asks for the PR's *current state* rather than for events, so
 * an app launched a week later learns exactly what a running one would have.
 *
 * The backend does all the work and returns the ids it changed, so there is nothing to drive here
 * beyond the timer — unlike `useQueueDrain`, where only the frontend can act on the answer.
 *
 * Failures are silent by design. A rate limit or a dropped connection means "ask again in three
 * minutes", and a toast for each would make the network's health look like the task's.
 */
export function usePullRequestPoll(projectId: number | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    const sweep = async () => {
      if (cancelled) return;
      try {
        const changed = await api.reconcilePullRequests(projectId);
        if (!cancelled && changed.length > 0) {
          void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
        }
      } catch {
        // Reported by the backend's own logging; see the note above on why this is not a toast.
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, queryClient]);
}
