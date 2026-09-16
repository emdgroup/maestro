import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { taskQueryKeys } from "@/services/task.service";
import type { Task } from "@/types/bindings";

/**
 * Long enough that a repository full of open pull requests does not become a rate-limit problem,
 * short enough that a merge landed over coffee is on the board when the user looks back.
 *
 * Deliberately slower than the session panel's 30s: that hook watches one branch, this one costs a
 * forge request per open pull request in the project, every pass.
 */
const POLL_MS = 3 * 60 * 1000;
/** The burst rate, for the seconds between opening a pull request and CI reporting. */
const BURST_POLL_MS = 6_000;
/** How many burst sweeps — 5 × 6s covers the window a forge takes to queue its first check. */
const BURST_TRIES = 5;

/**
 * How soon to sweep again, given whether anything is still unreported and how much burst is left.
 *
 * Exported so the rule can be tested directly rather than through a timer, for the reason
 * `branchPullRequestPollInterval` is: an interval buried in an effect is one no test can reach.
 */
export function sweepInterval(anyUnreported: boolean, burstsLeft: number): number {
  return anyUnreported && burstsLeft > 0 ? BURST_POLL_MS : POLL_MS;
}

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
 * `tasks` is what turns the steady timer into something that reacts. `open_pull_request_for_task`
 * writes the number synchronously and sets `pull_request_ci = NULL`, so a card approved with "open
 * a pull request" carried no CI state at all until the next three-minute tick. Watching the open
 * pull requests gives both halves of the fix: the effect re-runs the moment one appears, which is
 * the immediate sweep, and bursts while any of them is still unreported. The burst is bounded, so
 * a repository that simply has no CI settles back to the steady rate rather than spending five
 * requests a minute forever — steady-state cost is unchanged, only the post-approve window is
 * faster.
 *
 * Failures are silent by design. A rate limit or a dropped connection means "ask again in three
 * minutes", and a toast for each would make the network's health look like the task's.
 */
export function usePullRequestPoll(projectId: number | null, tasks: Task[]) {
  const queryClient = useQueryClient();

  // Archived tasks are in `get_tasks` but not in reconcile's SQL, so one of them sitting at
  // `AwaitingMerge` with no CI would hold `anyUnreported` true for the session and spend a full
  // burst on a question the backend will never answer.
  const open = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.phase === "AwaitingMerge" && t.pull_request_number != null && t.archived_at == null,
      ),
    [tasks],
  );
  // Changes exactly when a pull request is opened or another task reaches `AwaitingMerge` — the
  // analogue of `burstKeyOf`. Merely re-rendering the board must not re-arm a burst.
  const watchKey = useMemo(
    () =>
      open
        .map((t) => `${t.id}:${t.pull_request_number}`)
        .sort()
        .join(","),
    [open],
  );
  const anyUnreported = open.some((t) => t.pull_request_ci == null);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let burstsLeft = BURST_TRIES;

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
      if (cancelled) return;
      const next = sweepInterval(anyUnreported, burstsLeft);
      if (next === BURST_POLL_MS) burstsLeft -= 1;
      timer = setTimeout(() => void sweep(), next);
    };

    void sweep();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `watchKey` re-arms the burst and sweeps at once; `anyUnreported` drops back to the steady
    // rate as soon as the verdict lands. Both are strings/booleans, so this settles.
  }, [projectId, queryClient, watchKey, anyUnreported]);
}
