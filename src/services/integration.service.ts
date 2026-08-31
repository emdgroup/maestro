import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { issueTrackingQueryKeys } from "@/services/task.service";
import type { IntegrationStatus, LandingMode, ProjectIssueTrackingConfig } from "@/types/bindings";

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
