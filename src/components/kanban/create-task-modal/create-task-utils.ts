import type { ProjectIssueTrackingConfig } from "@/types/bindings";

export function stripProviderPrefix(externalId: string): string {
  const colon = externalId.indexOf(":");
  return colon >= 0 ? externalId.slice(colon + 1) : externalId;
}

export function getIssueSearchPlaceholder(config: ProjectIssueTrackingConfig): string {
  const { provider, owner, repo, project_path, project_key, team_id, project_name } = config;
  let context: string;
  switch (provider) {
    case "github":
    case "forgejo":
    case "gitea":
      context = owner && repo ? `${owner}/${repo}` : "";
      break;
    case "gitlab":
      context = project_path ?? "";
      break;
    case "jira_cloud":
      context = project_key ?? "";
      break;
    case "linear":
      context = team_id ?? "";
      break;
    case "azuredevops":
      context = project_name ?? "";
      break;
    default:
      context = "";
  }
  return context ? `Search ${context} issues` : "Search issues...";
}
