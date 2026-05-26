import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";

export const lookupQueryKeys = {
  githubOwner: (owner: string) => ["lookup", "github-owner", owner] as const,
  githubRepos: (owner: string) => ["lookup", "github-repos", owner] as const,
  jiraProjects: () => ["lookup", "jira-projects"] as const,
  linearTeams: () => ["lookup", "linear-teams"] as const,
  gitlabProjects: () => ["lookup", "gitlab-projects"] as const,
  forgejoRepos: (owner: string) => ["lookup", "forgejo-repos", owner] as const,
  giteaRepos: (owner: string) => ["lookup", "gitea-repos", owner] as const,
  azureDevOpsProjects: () => ["lookup", "azuredevops-projects"] as const,
};

export function useCheckGithubOwner(owner: string) {
  return useQuery({
    queryKey: lookupQueryKeys.githubOwner(owner),
    queryFn: () => api.checkGithubOwner(owner),
    enabled: owner.length >= 1,
    staleTime: 60_000,
    retry: false,
  });
}

export function useListGithubRepos(owner: string, enabled: boolean) {
  return useQuery({
    queryKey: lookupQueryKeys.githubRepos(owner),
    queryFn: () => api.listGithubRepos(owner),
    enabled: enabled && owner.length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function useListJiraProjects() {
  return useQuery({
    queryKey: lookupQueryKeys.jiraProjects(),
    queryFn: () => api.listJiraProjects(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useListLinearTeams() {
  return useQuery({
    queryKey: lookupQueryKeys.linearTeams(),
    queryFn: () => api.listLinearTeams(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useListGitlabProjects() {
  return useQuery({
    queryKey: lookupQueryKeys.gitlabProjects(),
    queryFn: () => api.listGitlabProjects(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useListForgejoRepos(owner: string, enabled: boolean) {
  return useQuery({
    queryKey: lookupQueryKeys.forgejoRepos(owner),
    queryFn: () => api.listForgejoRepos(owner),
    enabled: enabled && owner.length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function useListGiteaRepos(owner: string, enabled: boolean) {
  return useQuery({
    queryKey: lookupQueryKeys.giteaRepos(owner),
    queryFn: () => api.listGiteaRepos(owner),
    enabled: enabled && owner.length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function useListAzureDevOpsProjects() {
  return useQuery({
    queryKey: lookupQueryKeys.azureDevOpsProjects(),
    queryFn: () => api.listAzuredevopsProjects(),
    staleTime: 60_000,
    retry: false,
  });
}

function useRefreshByKey(queryKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey });
}

export function useRefreshGithubRepos(owner: string) {
  return useRefreshByKey(lookupQueryKeys.githubRepos(owner));
}

export function useRefreshForgejoRepos(owner: string) {
  return useRefreshByKey(lookupQueryKeys.forgejoRepos(owner));
}

export function useRefreshGiteaRepos(owner: string) {
  return useRefreshByKey(lookupQueryKeys.giteaRepos(owner));
}
