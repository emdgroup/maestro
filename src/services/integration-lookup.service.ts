import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";

export const lookupQueryKeys = {
  base: ["lookup"] as const,
  githubOwner: (owner: string) => [...lookupQueryKeys.base, "githubOwner", owner] as const,
  githubRepos: (owner: string) => [...lookupQueryKeys.base, "githubRepos", owner] as const,
  jiraProjects: () => [...lookupQueryKeys.base, "jiraProjects"] as const,
  linearTeams: () => [...lookupQueryKeys.base, "linearTeams"] as const,
  gitlabProjects: () => [...lookupQueryKeys.base, "gitlabProjects"] as const,
  forgejoRepos: (owner: string) => [...lookupQueryKeys.base, "forgejoRepos", owner] as const,
  giteaRepos: (owner: string) => [...lookupQueryKeys.base, "giteaRepos", owner] as const,
  azureDevOpsProjects: () => [...lookupQueryKeys.base, "azureDevOpsProjects"] as const,
  azureDevOpsRepos: (project: string) =>
    [...lookupQueryKeys.base, "azureDevOpsRepos", project] as const,
  bitbucketRepos: (workspace: string) =>
    [...lookupQueryKeys.base, "bitbucketRepos", workspace] as const,
  bitbucketProjects: () => [...lookupQueryKeys.base, "bitbucketProjects"] as const,
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

export function useListAzureDevOpsRepos(project: string, enabled: boolean) {
  return useQuery({
    queryKey: lookupQueryKeys.azureDevOpsRepos(project),
    queryFn: () => api.listAzuredevopsRepos(project),
    enabled: enabled && project.length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function useListBitbucketRepos(workspace: string, enabled: boolean) {
  return useQuery({
    queryKey: lookupQueryKeys.bitbucketRepos(workspace),
    queryFn: () => api.listBitbucketRepos(workspace),
    enabled: enabled && workspace.length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function useListBitbucketProjects() {
  return useQuery({
    queryKey: lookupQueryKeys.bitbucketProjects(),
    queryFn: () => api.listBitbucketProjects(),
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

export function useRefreshAzureDevOpsRepos(project: string) {
  return useRefreshByKey(lookupQueryKeys.azureDevOpsRepos(project));
}

export function useRefreshBitbucketRepos(workspace: string) {
  return useRefreshByKey(lookupQueryKeys.bitbucketRepos(workspace));
}

export function useRefreshBitbucketProjects() {
  return useRefreshByKey(lookupQueryKeys.bitbucketProjects());
}
