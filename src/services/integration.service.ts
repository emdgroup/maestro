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
  ProjectPullRequest,
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
 */
export function useBranchPullRequest(
  projectId: number | null,
  branch: string | null,
  enabled: boolean,
) {
  const burst = useRef<{ key: string; left: number } | null>(null);

  return useQuery({
    queryKey: integrationQueryKeys.branchPullRequest(projectId ?? -1, branch ?? ""),
    queryFn: () => api.fetchBranchPullRequest(projectId!, branch!),
    enabled: enabled && projectId != null && branch != null,
    refetchInterval: (query) => {
      const key = burstKeyOf(query.state.data);
      if (key != null && burst.current?.key !== key) {
        burst.current = { key, left: BURST_TRIES };
      }
      const interval = branchPullRequestPollInterval(query.state.data, burst.current?.left ?? 0);
      if (interval === BURST_POLL_MS && burst.current) burst.current.left -= 1;
      return interval;
    },
    // Refetched when the user comes back to the window, and when the session is selected again —
    // which is what re-arms detection after the timer has stopped on a merged pull request.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Every pull request open on the project's forge, in one request.
 *
 * The whole app's answer to "which pull request is on this branch". The Worktrees view matches its
 * cards against it, and so does each session's Overview card — one request for the project rather
 * than one per worktree. The session card does not read this: it asks about its own branch, which
 * is exact where one page of a project with thousands of open pull requests is not.
 *
 * The command answers an empty list rather than an error for a project with no forge, so there is
 * nothing to gate here beyond visibility.
 *
 * The stale window is not about freshness — the interval owns that — but about mounts, so that
 * leaving the Worktrees tab and coming back reuses the answer rather than re-asking for it.
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
