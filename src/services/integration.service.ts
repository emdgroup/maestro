import { useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { taskQueryKeys } from "@/services/task.service";
import type {
  BranchPullRequestInfo,
  IntegrationStatus,
  LandingMode,
  ProjectIssueTrackingConfig,
  PullRequestRowDetail,
  Task,
} from "@/types/bindings";

export type { IntegrationStatus, LandingMode, ProjectIssueTrackingConfig };

export const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  gitea: "Gitea",
  linear: "Linear",
  jira_cloud: "Jira Cloud",
  azuredevops: "Azure DevOps",
  bitbucket: "Bitbucket",
};

export type ProviderCapability = "issues" | "repos";

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapability[]> = {
  github: ["issues", "repos"],
  gitlab: ["issues", "repos"],
  forgejo: ["issues", "repos"],
  gitea: ["issues", "repos"],
  azuredevops: ["issues", "repos"],
  bitbucket: ["repos"],
  jira_cloud: ["issues"],
  linear: ["issues"],
};

export const integrationQueryKeys = {
  base: ["integrations"] as const,
  list: () => [...integrationQueryKeys.base, "list"] as const,
  projectIssueTracking: (projectId: number) =>
    [...integrationQueryKeys.base, "issueTracking", projectId] as const,
  detectIssueTracking: (projectId: number) =>
    [...integrationQueryKeys.base, "issueTrackingDetect", projectId] as const,
  remoteIssues: (projectId: number | null) =>
    [...integrationQueryKeys.base, "remoteIssues", projectId] as const,
  /**
   * Every project's code-hosting status, for invalidating after a credential changes. Connecting
   * a forge is not scoped to a project, so this prefix is what a connect has to reach.
   */
  codeHostingStatusAll: () => [...integrationQueryKeys.base, "codeHostingStatus"] as const,
  codeHostingStatus: (projectId: number) =>
    [...integrationQueryKeys.codeHostingStatusAll(), projectId] as const,
  // Keyed on the branch, not on a pull request number. The number is the *answer*, so keying on it
  // would mean holding it somewhere to ask the question — and a session whose #10 was closed and
  // replaced by a #11 opened on the forge would go on asking about #10 forever.
  branchPullRequest: (projectId: number | null, branch: string | null) =>
    [...integrationQueryKeys.base, "branchPullRequest", projectId, branch] as const,
  /**
   * One page of the project's open pull requests. The prefix is what a refresh invalidates, so it
   * reaches every page and every search the user has looked at.
   */
  projectPullRequests: (projectId: number | null) =>
    [...integrationQueryKeys.base, "projectPullRequests", projectId] as const,
  projectPullRequestPage: (projectId: number | null, cursor: string | null, search: string) =>
    [...integrationQueryKeys.projectPullRequests(projectId), cursor ?? "", search] as const,
  /**
   * One row's counts and CI verdict.
   *
   * Keyed on `updated_at` as well as the head sha, and that is the whole reason the answer can be
   * held instead of polled: a CI run starting or finishing moves neither the number nor the commit,
   * so a key without it would leave a row on its first answer until the user hit refresh.
   */
  pullRequestRowDetails: (projectId: number | null) =>
    [...integrationQueryKeys.base, "pullRequestRowDetail", projectId] as const,
  pullRequestRowDetail: (
    projectId: number | null,
    number: number,
    headSha: string | null,
    updatedAt: string | null,
  ) =>
    [...integrationQueryKeys.pullRequestRowDetails(projectId), number, headSha, updatedAt] as const,
};

/**
 * Fetches remote issues from the connected issue tracking provider.
 * Only runs while the modal is open (enabled: isModalOpen).
 * Automatically refetches every 5 minutes while open; stops when closed.
 */
export function useListRemoteIssuesQuery(projectId: number | null, isModalOpen: boolean) {
  return useQuery({
    queryKey: integrationQueryKeys.remoteIssues(projectId),
    queryFn: () => api.listRemoteIssues(projectId!),
    enabled: isModalOpen && projectId !== null,
    staleTime: 60_000,
    refetchInterval: isModalOpen ? 5 * 60 * 1000 : false,
    retry: 1,
  });
}

export function useListIntegrations() {
  return useQuery({
    queryKey: integrationQueryKeys.list(),
    queryFn: () => api.listIntegrations(),
    staleTime: 30_000,
  });
}

export function useSaveIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      token,
      instanceUrl,
      email,
    }: {
      provider: string;
      token: string;
      instanceUrl: string | null;
      email: string | null;
    }) => api.saveIntegration(provider, token, instanceUrl, email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
      // The status query asks whether a credential answers right now, so connecting one changes
      // its answer. Without this it keeps the previous "not connected" for its whole staleTime,
      // and both the settings card and the Approve modal go on saying so after the user has
      // just connected the forge.
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.codeHostingStatusAll() });
    },
    onError: createErrorToastHandler("Failed to connect integration"),
  });
}

export function useDeleteIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, id }: { provider: string; id: string }) =>
      api.deleteIntegration(provider, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
      // Same reasoning as the connect above, in the other direction.
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.codeHostingStatusAll() });
    },
    onError: createErrorToastHandler("Failed to disconnect integration"),
  });
}

export function useProjectIssueTrackingConfig(projectId: number) {
  return useQuery({
    queryKey: integrationQueryKeys.projectIssueTracking(projectId),
    queryFn: () => api.getProjectIssueTrackingConfig(projectId),
    staleTime: Infinity,
  });
}

/**
 * Reads the project's git remote to work out its issue tracking provider, applying the
 * config when the provider is already connected. The command writes at most once per
 * project — it refuses to touch a project that already has a config or opted out — so
 * running this as a query is safe.
 */
export function useDetectIssueTracking(projectId: number) {
  return useQuery({
    queryKey: integrationQueryKeys.detectIssueTracking(projectId),
    queryFn: () => api.detectProjectIssueTracking(projectId),
    enabled: projectId > 0,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * How far this project reaches up the code-hosting capability ladder: no remote, a remote
 * on an unrecognised host, a known forge nobody is connected to, or a forge we can open a
 * pull request against.
 *
 * Not cached across mounts on purpose. The top rung asks whether a credential answers
 * *right now* — `gh auth token` can supply one with no integration stored, and it stops
 * answering when the token expires — so a stale "Ready" would offer a PR that cannot be
 * opened. The detection half of the command is idempotent, so re-running it is free.
 */
export function useCodeHostingStatus(projectId: number) {
  return useQuery({
    queryKey: integrationQueryKeys.codeHostingStatus(projectId),
    queryFn: () => api.getProjectCodeHostingStatus(projectId),
    enabled: projectId > 0,
    staleTime: 60_000,
    retry: false,
  });
}

/** The steady rate: everything the card shows, once every half minute. */
const BRANCH_PULL_REQUEST_POLL_MS = 30_000;
/** The burst rate, for the seconds between opening a pull request and CI reporting. */
const BURST_POLL_MS = 3_000;
/** How many burst refetches — 5 × 3s covers the window a forge takes to queue its first check. */
const BURST_TRIES = 5;

/**
 * What a burst is armed for: this pull request, on this commit.
 *
 * `null` before anything has been found. A change here is the only thing that starts a burst — a
 * new pull request (including one Maestro just opened) or a push, both of which mean a CI run is
 * about to start. Merely looking at a session again does not, or every visit to a session whose
 * checks finished last week would spend five requests re-confirming them.
 */
export function burstKeyOf(pullRequest: BranchPullRequestInfo | null | undefined): string | null {
  return pullRequest ? `${pullRequest.number}:${pullRequest.head_sha ?? ""}` : null;
}

/**
 * How soon to ask again, given the last answer and how much burst is left.
 *
 * Exported so it can be tested directly: an interval rule buried in query options is one no test
 * can reach, which is how a repository with no CI once ended up polling for the life of a session.
 *
 * `false` stops the timer for good. A merged or closed pull request cannot change again, and window
 * focus is what re-arms this query rather than a timer nobody is watching.
 */
export function branchPullRequestPollInterval(
  pullRequest: BranchPullRequestInfo | null | undefined,
  burstsLeft: number,
): number | false {
  // No pull request on this branch yet. Keep looking — this is how one opened on the forge arrives.
  if (pullRequest == null) return BRANCH_PULL_REQUEST_POLL_MS;
  if (pullRequest.state !== "Open") return false;
  // The window between opening a pull request and the forge queueing its first check. Bounded, so a
  // repository that simply has no CI settles to the steady rate instead of bursting forever.
  if (burstsLeft > 0 && pullRequest.checks.length === 0) return BURST_POLL_MS;
  return BRANCH_PULL_REQUEST_POLL_MS;
}

/**
 * The pull request on a session's branch, whole, in one query.
 *
 * Detection, state and CI are one question because on GitHub they are one *request*: a
 * single-pull-request GraphQL call carrying every named check costs one point of an hourly 5,000.
 * Splitting them saved nothing and cost the card its consistency, since the header and the check
 * ring would be fed by different polls.
 *
 * Keyed on the branch rather than on a number, so there is no remembered identity to go stale: a
 * `#10` closed and replaced by a `#11` opened on the forge is picked up by the same question.
 *
 * The stale window is about session switching rather than freshness — the interval owns that. At
 * `staleTime: 0` every click between two sessions would fire a request each.
 *
 * The Worktrees grid asks the same question with `poll: false`. It has to ask per-branch rather
 * than read the paged list, or a worktree whose pull request sits on page seven loses its chip —
 * but a grid polling at the session's rate would be a request per card per thirty seconds.
 * Unpolled the cards cost one request each on open, and share this cache with the session panel.
 */
export function useBranchPullRequest(
  projectId: number | null,
  branch: string | null,
  enabled: boolean,
  /** `true` for the one session panel on screen; `false` for a card in a grid of them. */
  poll = true,
) {
  const burst = useRef<{ key: string; left: number } | null>(null);

  return useQuery({
    queryKey: integrationQueryKeys.branchPullRequest(projectId, branch),
    queryFn: () => api.fetchBranchPullRequest(projectId!, branch!),
    enabled: enabled && projectId != null && branch != null,
    refetchInterval: (query) => {
      if (!poll) return false;
      const key = burstKeyOf(query.state.data);
      if (key != null && burst.current?.key !== key) {
        burst.current = { key, left: BURST_TRIES };
      }
      const interval = branchPullRequestPollInterval(query.state.data, burst.current?.left ?? 0);
      if (interval === BURST_POLL_MS && burst.current) burst.current.left -= 1;
      return interval;
    },
    // Refetched when the user comes back to the window, and when the session is selected again —
    // which is what re-arms detection after the timer has stopped on a merged pull request. The
    // stale window below is what keeps that affordable for a whole grid: a focus inside it costs
    // nothing, so twenty cards do not become twenty requests every time the window is clicked.
    refetchOnWindowFocus: true,
    staleTime: poll ? 10_000 : 5 * 60_000,
    retry: false,
  });
}

/** How often the visible page is re-read. See [`useProjectPullRequestPage`]. */
const PULL_REQUEST_PAGE_POLL_MS = 30_000;

/**
 * One page of the project's open pull requests.
 *
 * A page, not the list. `nixpkgs` has around eleven thousand open at once, so "all of them" was
 * never on offer. This asks for thirty, says how many there are, and hands back a cursor.
 *
 * On GitHub the same request carries every row's line counts and CI verdict, because they are free
 * scalars on nodes the query already pays for — which is what removes the per-row request beside it.
 *
 * `search` goes to the forge in the same request rather than filtering what came back. Filtering
 * thirty rows out of eleven thousand finds almost nothing and reads as an empty project.
 *
 * The command answers an empty page rather than an error for a project with no forge, so there is
 * nothing to gate here beyond visibility.
 */
export function useProjectPullRequestPage(
  projectId: number | null,
  cursor: string | null,
  search: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: integrationQueryKeys.projectPullRequestPage(projectId, cursor, search),
    queryFn: () => api.listProjectPullRequests(projectId!, cursor, search || null),
    enabled: enabled && projectId != null,
    refetchInterval: PULL_REQUEST_PAGE_POLL_MS,
    // Long enough that paging back and forth reuses what it already has, short enough that the
    // interval above is what owns freshness.
    staleTime: 15_000,
    // A page the user has moved past is not worth keeping alive; the next visit re-asks.
    placeholderData: (previous) => previous,
    retry: false,
  });
}

/**
 * One row's line counts, file count and CI verdict, fetched once and then held.
 *
 * Only for the forges whose list request cannot answer it — on GitHub `detail` arrives populated and
 * `enabled` is never true, and on Bitbucket and Azure DevOps the backend fills in an empty answer
 * rather than an absent one precisely so this stays quiet. Neither needs a provider check here: a
 * `null` detail *is* the signal, and it is the backend that decides what `null` means.
 *
 * `staleTime: Infinity` is not a claim about freshness. The key holds the number, the head sha and
 * `updated_at`, so everything that could change this answer changes the key instead — a push, a
 * rename, a merge, a pipeline event. Nothing is left for a refetch to discover.
 *
 * The one exception is a run still going, which finishes without touching any of the three on some
 * forges. That row, and only that row, keeps a poll.
 */
export function rowDetailPollInterval(detail: PullRequestRowDetail | undefined): number | false {
  // Exported and separate so the rule can be read on its own. The bug this design replaces was an
  // interval condition buried in a hook, which no test could reach and nobody noticed was wrong.
  return detail?.ci === "Running" ? PULL_REQUEST_PAGE_POLL_MS : false;
}

export function usePullRequestRowDetail(
  projectId: number | null,
  number: number,
  headSha: string | null,
  updatedAt: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: integrationQueryKeys.pullRequestRowDetail(projectId, number, headSha, updatedAt),
    queryFn: () => api.fetchPullRequestRowDetail(projectId!, number, headSha),
    enabled: enabled && projectId != null,
    refetchInterval: (query) => rowDetailPollInterval(query.state.data),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Open a pull request for a branch, touching no task.
 *
 * Puts the new pull request straight into the branch query's cache. Not a guess standing in for
 * the forge's answer — it *is* the forge's answer, from the response that created it.
 *
 * Invalidating instead means waiting: a refetch milliseconds after the POST can land before the
 * forge has caught up with its own write, and "no such pull request" is indistinguishable from
 * "not caught up yet" — leaving the card blank until a full interval later.
 *
 * This is the key the session panel *and* the worktree card both read, so seeding it paints both
 * with no round trip at all.
 */
export function useOpenPullRequestForBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      branch,
      base,
      title,
      body,
    }: {
      projectId: number;
      branch: string;
      base: string;
      title: string;
      body: string;
    }) => api.openPullRequestForBranch(projectId, branch, base, title, body),
    onSuccess: (opened, { projectId, branch, base, title }) => {
      // The session card, painted with no round trip at all. Every field here is the forge's own
      // answer to the request that created it, or an argument we sent — nothing is a guess. The
      // counts and `mergeable` are absent rather than zero, and the first poll fills them in.
      //
      // Writing this also arms the checks burst: the query had no pull request a moment ago and now
      // has this one, which is exactly the change `burstKeyOf` watches for.
      queryClient.setQueryData(integrationQueryKeys.branchPullRequest(projectId, branch), {
        number: opened.number,
        url: opened.url,
        state: "Open",
        title,
        base_branch: base,
        head_branch: branch,
        head_sha: opened.head_sha,
        created_at: new Date().toISOString(),
        commits: null,
        changed_files: null,
        additions: null,
        deletions: null,
        mergeable: null,
        checks: [],
      } satisfies BranchPullRequestInfo);

      // The Worktrees *panel* is not seeded, only invalidated, and it is allowed to lag. Its rows
      // are pages the forge orders and counts, so a hand-placed entry would have to guess which
      // page it belongs on and what it does to the total — and a list endpoint routinely has not
      // caught up with its own write, so an immediate refetch can answer "no such pull request".
      // Nothing depends on it being instant: the seed above is what paints the session card, the
      // worktree card asks about its own branch and hits that same seed, and the panel's own 30s
      // poll picks the row up at the top of page one, where `UPDATED_AT desc` puts it.
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.projectPullRequests(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to open the pull request"),
  });
}

/**
 * How approved work leaves Review for this project: merged locally, pushed as a pull request, or
 * pushed and left for someone else. Stored in `.maestro/settings.json`, so it is the team's
 * choice rather than this machine's.
 */
export function useSaveProjectLandingMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, landingMode }: { projectId: number; landingMode: LandingMode }) =>
      api.saveProjectLandingMode(projectId, landingMode),
    // The status query carries the landing mode, and the Approve modal takes its default from it.
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.codeHostingStatus(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to save how work leaves Review"),
  });
}

export function useSaveProjectIssueTrackingConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      issueTracking,
    }: {
      projectId: number;
      issueTracking: ProjectIssueTrackingConfig | null;
    }) => api.saveProjectIssueTrackingConfig(projectId, issueTracking),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.projectIssueTracking(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.remoteIssues(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.detectIssueTracking(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to save issue tracking config"),
  });
}

/**
 * Long enough that a repository full of open pull requests does not become a rate-limit problem,
 * short enough that a merge landed over coffee is on the board when the user looks back.
 *
 * Deliberately slower than the session panel's 30s: that hook watches one branch, this one costs a
 * forge request per open pull request in the project, every pass.
 */
const RECONCILE_POLL_MS = 3 * 60 * 1000;
/**
 * The steady rate while the user is looking at the board, where a merge landing late is visible.
 * Away from it, nobody is watching the cards, so the slower rate keeps the forge cost down.
 */
const RECONCILE_FOCUSED_POLL_MS = 60 * 1000;
/**
 * The sweep's burst rate. Slower than the branch poll's, since each sweep asks about every open
 * pull request; `BURST_TRIES` of these cover the window a forge takes to queue its first check.
 */
const RECONCILE_BURST_POLL_MS = 6_000;

/**
 * How soon to sweep again, given whether anything is still unreported, how much burst is left and
 * whether the user is looking at the board.
 *
 * Exported so the rule can be tested directly rather than through a timer, for the reason
 * `branchPullRequestPollInterval` is: an interval buried in an effect is one no test can reach.
 */
export function sweepInterval(
  anyUnreported: boolean,
  burstsLeft: number,
  focused: boolean,
): number {
  if (anyUnreported && burstsLeft > 0) return RECONCILE_BURST_POLL_MS;
  return focused ? RECONCILE_FOCUSED_POLL_MS : RECONCILE_POLL_MS;
}

/**
 * Asks the forge what became of the pull requests this project is waiting on.
 *
 * The sweep on mount is what covers the app not running when a pull request merged, and it needs
 * no separate mechanism: the backend asks for the PR's *current state* rather than for events, so
 * an app launched a week later learns exactly what a running one would have.
 *
 * The backend does all the work and returns the ids it changed, so there is nothing to drive here
 * beyond the timer.
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
 * `onBoard` is whether the board's tab is the one on screen. Arriving there, by tab or by bringing
 * the window back to the front, sweeps at once, and while the window has focus there the steady
 * rate is a minute rather than three: a merge done on the forge is then on the card by the time the
 * user is back looking at it.
 *
 * Failures are silent by design. A rate limit or a dropped connection means "ask again in three
 * minutes", and a toast for each would make the network's health look like the task's.
 */
export function usePullRequestPoll(projectId: number | null, tasks: Task[], onBoard: boolean) {
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

  // Read through refs so that arriving on the board wakes the running loop rather than re-running
  // the effect below, which would also sweep on leaving it and re-arm a spent burst each time.
  const onBoardRef = useRef(onBoard);
  const wakeRef = useRef(() => {});
  useEffect(() => {
    onBoardRef.current = onBoard;
    if (onBoard) wakeRef.current();
  }, [onBoard]);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    let burstsLeft = BURST_TRIES;

    const sweep = async () => {
      if (cancelled) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const changed = await api.reconcilePullRequests(projectId);
        if (!cancelled && changed.length > 0) {
          void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
        }
      } catch {
        // Reported by the backend's own logging; see the note above on why this is not a toast.
      }
      inFlight = false;
      if (cancelled) return;
      const focused = onBoardRef.current && document.hasFocus();
      const next = sweepInterval(anyUnreported, burstsLeft, focused);
      if (next === RECONCILE_BURST_POLL_MS) burstsLeft -= 1;
      timer = setTimeout(() => void sweep(), next);
    };

    // A sweep already on the wire answers the same question, and starting a second would leave
    // two timers chained after it.
    const wake = () => {
      if (!inFlight) void sweep();
    };
    const onWindowFocus = () => {
      if (onBoardRef.current) wake();
    };
    wakeRef.current = wake;
    window.addEventListener("focus", onWindowFocus);

    void sweep();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onWindowFocus);
      wakeRef.current = () => {};
    };
    // `watchKey` re-arms the burst and sweeps at once; `anyUnreported` drops back to the steady
    // rate as soon as the verdict lands. Both are strings/booleans, so this settles.
  }, [projectId, queryClient, watchKey, anyUnreported]);
}
