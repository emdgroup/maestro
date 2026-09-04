import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { issueTrackingQueryKeys } from "@/services/task.service";
import type {
  IntegrationStatus,
  LandingMode,
  ProjectIssueTrackingConfig,
  ProjectPullRequest,
  PullRequestCheckInfo,
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
  // Keyed on the head sha as well as the number: a push replaces the whole run, and the previous
  // commit's results are not a stale version of the new ones, they are a different answer.
  pullRequestChecks: (projectId: number, number: number, headSha: string) =>
    [...integrationQueryKeys.base, "pull_request_checks", projectId, number, headSha] as const,
  projectPullRequests: (projectId: number) =>
    [...integrationQueryKeys.base, "project_pull_requests", projectId] as const,
  // `heads` fingerprints every listed pull request's number and head sha. A push has to re-ask
  // rather than reuse the previous commit's marks, and that is the only thing that changes here
  // without the project changing.
  projectPullRequestChecks: (projectId: number, heads: string) =>
    [...integrationQueryKeys.base, "project_pull_request_checks", projectId, heads] as const,
  // Same head-sha keying as the checks: a push is a different question, not a stale answer to this
  // one. It is not what keeps the answer fresh, though — state, title and mergeable all change with
  // the head commit standing still, which is why the session polls this rather than caching it.
  pullRequestDetail: (projectId: number, number: number, headSha: string) =>
    [...integrationQueryKeys.base, "pull_request_detail", projectId, number, headSha] as const,
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

/** While the answer can still change on its own. */
const CHECKS_LIVE_POLL_MS = 10_000;
/** Once nothing is running. Not stopped entirely — see [`useBranchPullRequestChecks`]. */
const CHECKS_SETTLED_POLL_MS = 30_000;
/**
 * How many empty answers still count as "CI has not started yet".
 *
 * Six at the live rate is about a minute, which is longer than any forge here takes to queue a
 * check run. Past that an empty list is not a pull request waiting for CI, it is a repository
 * without any — and treating the two the same polled a permanently empty answer at ten seconds for
 * the life of the session.
 */
const CHECKS_EMPTY_POLLS_BEFORE_BACKOFF = 6;

/**
 * How soon to ask about a pull request's checks again, given the last answer.
 *
 * Exported for its own test rather than left inline in the query options: the whole point of this
 * function is which answers stop deserving the fast rate, and that is exactly what got it wrong —
 * an empty list read as "not started yet" forever, so a repository with no CI polled every ten
 * seconds for the life of the session.
 *
 * @param checks the last answer, `undefined` before the first one arrives
 * @param updateCount successful fetches under this key, which a push resets along with the key
 */
export function checksPollInterval(
  checks: PullRequestCheckInfo[] | undefined,
  updateCount: number,
): number {
  if (checks == null) return CHECKS_LIVE_POLL_MS;
  if (checks.length === 0) {
    return updateCount < CHECKS_EMPTY_POLLS_BEFORE_BACKOFF
      ? CHECKS_LIVE_POLL_MS
      : CHECKS_SETTLED_POLL_MS;
  }
  return checks.some((check) => check.status === "Running")
    ? CHECKS_LIVE_POLL_MS
    : CHECKS_SETTLED_POLL_MS;
}

/**
 * One session's pull request checks, polled at the rate the answer is actually moving.
 *
 * Two rates rather than one, because the same interval cannot serve both ends. An empty list is the
 * window between opening a pull request and the forge queueing its first check, and a `Running`
 * check is a run in progress: both are answers that change on their own, and both are what the user
 * is watching the card for. Everything finished is not — a green pull request asked about every ten
 * seconds costs a request per poll for the rest of the session to confirm what it already said.
 *
 * An empty list is only treated as "not started yet" for the first
 * [`CHECKS_EMPTY_POLLS_BEFORE_BACKOFF`] answers. After that it means the repository has no CI, and
 * before this bound existed that case polled at the live rate forever — for the life of the
 * session, on a card that could never show anything.
 *
 * Slowed rather than stopped, because settled is not final: a forge can queue a check run under a
 * head sha whose other runs have all finished, and re-running a failed job changes nothing else the
 * card could notice.
 *
 * Keyed on the head sha as well as the number, so a push asks a new question under a new key rather
 * than serving the previous commit's answer — which also resets the empty-answer count, so a push
 * into a repository that has just gained CI is watched at the fast rate again.
 *
 * Runs only for an open pull request, and only on a forge that names its checks — a merged pull
 * request's cannot change, and a forge that will not enumerate answers an empty list by
 * construction.
 */
export function useBranchPullRequestChecks(
  projectId: number | null,
  number: number | null,
  headSha: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: integrationQueryKeys.pullRequestChecks(projectId ?? -1, number ?? -1, headSha ?? ""),
    queryFn: () => api.fetchBranchPullRequestChecks(projectId!, number!, headSha),
    enabled: enabled && projectId != null && number != null,
    // `dataUpdateCount` is per key, so a push resets the empty-answer count with the answer itself.
    refetchInterval: (query) => checksPollInterval(query.state.data, query.state.dataUpdateCount),
    // No stale window worth the name: the interval owns freshness here, and a longer one would only
    // decide whether a remount re-asks.
    staleTime: 2_000,
    retry: false,
  });
}

/**
 * Every pull request open on the project's forge, in one request.
 *
 * The whole app's answer to "which pull request is on this branch". The Worktrees view matches its
 * cards against it, and so does each session's Overview card — one request for the project rather
 * than one per worktree or, as the session panel used to, four per session. Every caller shares this
 * key, so the query runs while *any* of them wants it and stops when the last one looks away.
 *
 * The command answers an empty list rather than an error for a project with no forge, so there is
 * nothing to gate here beyond visibility.
 *
 * The stale window is not about freshness — the interval owns that — but about mounts. Sessions
 * enable this as they come on screen, and at `staleTime: 0` every switch between them was a fresh
 * request, which is the cost this list exists to avoid. Fifteen seconds is the same floor
 * `useRefreshProjectPullRequests` applies, so the two cannot disagree about what counts as recent.
 */
export function useProjectPullRequests(projectId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: integrationQueryKeys.projectPullRequests(projectId ?? -1),
    queryFn: () => api.listProjectPullRequests(projectId!),
    enabled: enabled && projectId != null,
    refetchInterval: 60_000,
    staleTime: 15_000,
    retry: false,
  });
}

/** How often an open pull request's own fields are re-read. See [`usePullRequestDetail`]. */
const DETAIL_POLL_MS = 30_000;

/**
 * Everything about one pull request except its checks — state, title, branches and diff counts.
 *
 * One query where there were two, because on every forge that answers both halves they arrive in
 * one response: `/repos/{o}/{r}/pulls/{n}` on GitHub and Gitea, the merge request URL on GitLab.
 * The old split asked that URL twice per poll to parse different halves of the same body.
 *
 * Polled rather than cached against the head sha, which is what the counts alone allowed. Three
 * things change without the head commit moving, and all three were invisible before: a rename, a
 * merge, and `mergeable` — GitHub computes the merge commit in the background and answers `null`
 * until it has one, so the first read after any push says "no answer" and a cache keyed on the
 * commit would have kept that answer until the next one.
 *
 * Stops once the pull request settles. Merged is terminal on every forge here, and a reopen comes
 * back through the open list rather than through this query, so there is nothing left to watch.
 */
export function usePullRequestDetail(
  projectId: number | null,
  number: number | null,
  headSha: string | null,
  enabled: boolean,
  /**
   * `true` for the one card the user is watching. `false` for a list, where polling would be a
   * request per row per interval — the cost the project-wide list and the batch checks query exist
   * to avoid, reintroduced through the back door.
   */
  poll: boolean,
) {
  return useQuery({
    queryKey: integrationQueryKeys.pullRequestDetail(projectId ?? -1, number ?? -1, headSha ?? ""),
    queryFn: () => api.fetchPullRequestDetail(projectId!, number!),
    enabled: enabled && projectId != null && number != null,
    refetchInterval: (query) =>
      poll && query.state.data?.state === "Open" ? DETAIL_POLL_MS : false,
    // Polled: short enough that returning to a session re-reads it, which is what picks up a rename
    // made while the user was looking somewhere else. Unpolled: the key already holds the head sha,
    // so the only thing a stale window could do is re-ask the same question about the same commit.
    staleTime: poll ? 5_000 : Infinity,
    retry: false,
  });
}

/**
 * Ask the open list to refresh, unless it just did.
 *
 * The caller is a session that looked for its branch, found nothing, and wants to be sure the list
 * is not simply out of date — which is every session on a branch that will never have a pull
 * request, every time the user switches to it. The floor is what keeps that from being a request
 * per switch; without it, flicking between sessions polls the forge as fast as the user can click.
 */
export function useRefreshProjectPullRequests(projectId: number | null) {
  const queryClient = useQueryClient();
  return useCallback(
    (minAgeMs = 15_000) => {
      if (projectId == null) return;
      const key = integrationQueryKeys.projectPullRequests(projectId);
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      if (Date.now() - updatedAt < minAgeMs) return;
      void queryClient.invalidateQueries({ queryKey: key });
    },
    [queryClient, projectId],
  );
}

/**
 * Open a pull request for a branch, touching no task.
 *
 * Puts the new pull request straight into the cached open list. That is not a guess standing in for
 * the forge's answer — it *is* the forge's answer, from the response to the request that created
 * it, and every field the list carries was either in that response or in the arguments we sent.
 *
 * Doing it any other way meant waiting: invalidating instead refetched within milliseconds of the
 * POST, before the list endpoint had caught up with its own write, and a list that answers "no such
 * pull request" is indistinguishable from one that has not caught up. The next attempt was a full
 * interval later, which is the minute users spent watching a card that should already have been
 * there. The delayed refresh below is the safety net for forges whose create response omits the
 * head sha, not the mechanism.
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
      const key = integrationQueryKeys.projectPullRequests(projectId);
      queryClient.setQueryData(key, (previous: ProjectPullRequest[] | undefined) => {
        const entry: ProjectPullRequest = {
          number: opened.number,
          url: opened.url,
          title,
          head_branch: branch,
          base_branch: base,
          created_at: new Date().toISOString(),
          head_sha: opened.head_sha,
        };
        const rest = (previous ?? []).filter((item) => item.number !== opened.number);
        return [entry, ...rest];
      });

      // A forge that did not name the head commit leaves the checks query with nothing to key on,
      // so the list has to be asked again for it. Delayed rather than immediate for the reason in
      // the comment above, and harmless when the seed was already complete.
      if (opened.head_sha == null) {
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: key });
        }, 2_000);
      }
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
