export interface InstructionLine {
  text: string;
  code?: boolean;
}

export function getProviderFields(provider: string): {
  showInstanceUrl: boolean;
  instanceUrlLabel: string;
  instanceUrlPlaceholder: string;
  showEmail: boolean;
  tokenLabel: string;
} {
  switch (provider) {
    case "gitlab":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://gitlab.com",
        showEmail: false,
        tokenLabel: "Token",
      };
    case "forgejo":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://codeberg.org",
        showEmail: false,
        tokenLabel: "Token",
      };
    case "jira_cloud":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Site URL",
        instanceUrlPlaceholder: "https://yourorg.atlassian.net",
        showEmail: true,
        tokenLabel: "API Token",
      };
    case "azuredevops":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Organization URL",
        instanceUrlPlaceholder: "https://dev.azure.com/yourorg",
        showEmail: false,
        tokenLabel: "Personal Access Token",
      };
    case "gitea":
      return {
        showInstanceUrl: true,
        instanceUrlLabel: "Instance URL",
        instanceUrlPlaceholder: "https://gitea.example.com",
        showEmail: false,
        tokenLabel: "Token",
      };
    case "linear":
      return {
        showInstanceUrl: false,
        instanceUrlLabel: "",
        instanceUrlPlaceholder: "",
        showEmail: false,
        tokenLabel: "API Key",
      };
    default:
      return {
        showInstanceUrl: false,
        instanceUrlLabel: "",
        instanceUrlPlaceholder: "",
        showEmail: false,
        tokenLabel: "Token",
      };
  }
}

export function getProviderInstructions(provider: string): InstructionLine[] | null {
  switch (provider) {
    case "github":
      return [
        { text: "Open GitHub → Settings → Developer settings → Personal access tokens" },
        { text: "Click Generate new token (classic) → add a note" },
        { text: "Select scopes: repo, read:user" },
        { text: "Click Generate token and copy it immediately" },
        { text: "Tip: if gh CLI is authenticated, Maestro will auto-detect your token." },
      ];
    case "gitlab":
      return [
        { text: "Open GitLab → click your avatar → Edit profile → Access Tokens" },
        { text: "Enter a name, optional expiry, and select scopes:", code: false },
        { text: "read_api, read_user, read_repository", code: true },
        { text: "Click Create personal access token and copy it immediately" },
      ];
    case "forgejo":
      return [
        { text: "Log into your Forgejo instance" },
        { text: "Go to Settings → Applications → Manage Access Tokens" },
        { text: "Enter a token name, select issue scope (read)" },
        { text: "Click Generate Token and copy it immediately" },
      ];
    case "linear":
      return [
        { text: "Open Linear → Settings → API → Personal API Keys" },
        { text: "Click Create key → enter a label" },
        { text: "Copy the key immediately — it won't be shown again" },
      ];
    case "jira_cloud":
      return [
        { text: "Go to: https://id.atlassian.com/manage-profile/security/api-tokens", code: true },
        { text: "Click Create API token → enter a label → Create" },
        { text: "Copy the token immediately — it won't be shown again" },
        { text: "Site URL: your *.atlassian.net domain (e.g. yourorg.atlassian.net)" },
        { text: "Email: your Atlassian account email address" },
      ];
    case "azuredevops":
      return [
        {
          text: "Sign in to dev.azure.com → click user settings, left of user avatar → Personal access tokens",
        },
        { text: "Click New Token → select your Organization" },
        { text: "Under Scopes, select Work Items (Read)" },
        { text: "Click Create and copy the token immediately" },
      ];
    case "gitea":
      return [
        { text: "Log into your Gitea instance" },
        { text: "Go to Settings → Applications → Manage Access Tokens" },
        { text: "Enter a token name, select issue scope (read)" },
        { text: "Click Generate Token and copy it immediately" },
      ];
    default:
      return null;
  }
}

export const BITBUCKET_INSTRUCTIONS: Record<"cloud" | "server", InstructionLine[]> = {
  cloud: [
    { text: "Go to Bitbucket → Personal settings → App passwords" },
    { text: "Click Create app password → enter a label" },
    { text: "Select Repositories (Read) permissions" },
    { text: "Click Create — copy the password immediately" },
  ],
  server: [
    { text: "Log into your Bitbucket Server or Data Center instance" },
    { text: "Click your avatar → Manage account → HTTP access tokens" },
    { text: "Click Create token → enter a name, select Repositories (Read)" },
    { text: "Click Create — copy the token immediately" },
  ],
};
