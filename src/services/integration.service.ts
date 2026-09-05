import { useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { issueTrackingQueryKeys } from "@/services/task.service";
import type {
  BranchPullRequestInfo,
  IntegrationStatus,
  LandingMode,
  ProjectIssueTrackingConfig,
  PullRequestRowDetail,
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
    [...integrationQueryKeys.base, "issue_tracking", projectId] as const,
  detectIssueTracking: (projectId: number) =>
    [...integrationQueryKeys.base, "issue_tracking_detect", projectId] as const,
  /**
   * Every project's code-hosting status, for invalidating after a credential changes. Connecting
   * a forge is not scoped to a project, so this prefix is what a connect has to reach.
   */
  codeHostingStatusAll: () => [...integrationQueryKeys.base, "code_hosting_status"] as const,
  codeHostingStatus: (projectId: number) =>
    [...integrationQueryKeys.base, "code_hosting_status", projectId] as const,
  // Keyed on the branch, not on a pull request number. The number is the *answer*, so keying on it
  // would mean holding it somewhere to ask the question — and a session whose #10 was closed and
  // replaced by a #11 opened on the forge would go on asking about #10 forever.
  branchPullRequest: (projectId: number, branch: string) =>
    [...integrationQueryKeys.base, "branch_pull_request", projectId, branch] as const,
  /**
   * One page of the project's open pull requests. The prefix is what a refresh invalidates, so it
   * reaches every page and every search the user has looked at.
   */
  projectPullRequests: (projectId: number) =>
    [...integrationQueryKeys.base, "project_pull_requests", projectId] as const,
  projectPullRequestPage: (projectId: number, cursor: string | null, search: string) =>
    [...integrationQueryKeys.projectPullRequests(projectId), cursor ?? "", search] as const,
  /**
   * One row's counts and CI verdict.
   *
   * Keyed on `updated_at` as well as the head sha, and that is the whole reason the answer can be
   * held instead of polled: a CI run starting or finishing moves neither the number nor the commit,
   * so a key without it would leave a row on its first answer until the user hit refresh.
   */
  pullRequestRowDetails: (projectId: number) =>
    [...integrationQueryKeys.base, "pull_request_row_detail", projectId] as const,
  pullRequestRowDetail: (projectId: number, number: number, headSha: string, updatedAt: string) =>
    [...integrationQueryKeys.pullRequestRowDetails(projectId), number, headSha, updatedAt] as const,
};

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
 * Exported for its own test rather than left inline in the query options. The rule this replaces
 * was inline, and its bug — an empty check list read as "CI has not started yet" *forever*, so a
 * repository without CI polled every ten seconds for the life of the session — was invisible
 * precisely because there was nothing to call directly.
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
 * Detection, state and CI used to be three queries at three rates. They are one because on GitHub
 * they are one *request*: a single-pull-request GraphQL call carrying every named check costs one
 * point of an hourly 5,000, so asking for state alone saved nothing and cost the card its
 * consistency — the header and the check ring were fed by different polls and could describe
 * different moments.
 *
 * Keyed on the branch rather than on a number, so there is no remembered identity to go stale: a
 * `#10` closed and replaced by a `#11` opened on the forge is picked up by the same question.
 *
 * The stale window is not about freshness — the interval owns that — but about session switching.
 * At `staleTime: 0` every click between two sessions would fire a request each, which is what a
 * per-session lookup has to avoid to be affordable at all.
 *
 * The Worktrees view's cards ask the same question with `poll: false`. They have to ask it
 * per-branch rather than read a shared list, because that list is now one page of thirty and a
 * worktree whose pull request sits on page seven would silently lose its chip — but a grid of them
 * polling at the session's rate would be a request per card per thirty seconds. Unpolled they cost
 * one request each when the tab opens and nothing after, and they share this cache with the session
 * panel, so opening a session the grid already asked about costs nothing at all.
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
    queryKey: integrationQueryKeys.branchPullRequest(projectId ?? -1, branch ?? ""),
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
 * never on offer — the previous version asked for a hundred and rendered `100/100`, which is a
 * denominator that happens to be a lie on every large repository. This asks for thirty, says how
 * many there are, and hands back a cursor for the next.
 *
 * On GitHub this single request also carries every row's line counts and CI verdict, because they
 * are free scalars on nodes the query already pays for — which is what removes the per-row request
 * the panel used to make and the ~101-point batch check query beside it.
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
    queryKey: integrationQueryKeys.projectPullRequestPage(projectId ?? -1, cursor, search),
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
    queryKey: integrationQueryKeys.pullRequestRowDetail(
      projectId ?? -1,
      number,
      headSha ?? "",
      updatedAt ?? "",
    ),
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
 * Puts the new pull request straight into the branch query's cache. That is not a guess standing in
 * for the forge's answer — it *is* the forge's answer, from the response to the request that created
 * it, and every field written below was either in that response or in the arguments we sent.
 *
 * Doing it any other way meant waiting: invalidating instead refetched within milliseconds of the
 * POST, before the forge had caught up with its own write, and an endpoint answering "no such pull
 * request" is indistinguishable from one that has not caught up. The next attempt was a full
 * interval later, which is the minute users spent watching a card that should already have been
 * there.
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
        queryKey: issueTrackingQueryKeys.remoteIssues(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: integrationQueryKeys.detectIssueTracking(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to save issue tracking config"),
  });
}
