import { useState } from "react";
import { Plus, X } from "lucide-react";
import { siGithub, siGitlab, siForgejo, siLinear, siJira } from "simple-icons";
import { Button } from "@/ui/button";
import { useListIntegrations, useDeleteIntegration } from "@/services/integration.service";
import { IntegrationConnectDialog } from "@/components/project-picker/IntegrationConnectDialog";

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  linear: "Linear",
  jira_cloud: "Jira Cloud",
  azuredevops: "Azure DevOps",
};

// Ordered as: row 1: GitHub, Jira Cloud | row 2: Linear, GitLab | row 3: Azure DevOps, Forgejo
const ALL_PROVIDERS = ["github", "jira_cloud", "linear", "gitlab", "azuredevops", "forgejo"];

const PROVIDER_SIMPLE_ICONS: Record<string, { path: string; viewBox?: string }> = {
  github: siGithub,
  gitlab: siGitlab,
  forgejo: siForgejo,
  linear: siLinear,
  jira_cloud: siJira,
  azuredevops: {
    path: "M17,4v9.74l-4,3.28-6.2-2.26V17L3.29,12.41l10.23.8V4.44Zm-3.41.49L7.85,1V3.29L2.58,4.84,1,6.87v4.61l2.26,1V6.57Z",
    viewBox: "0 0 18 18",
  },
};

export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const icon = PROVIDER_SIMPLE_ICONS[provider];
  if (!icon) return null;
  return (
    <svg
      role="img"
      viewBox={icon.viewBox ?? "0 0 24 24"}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="currentColor"
      aria-label={PROVIDER_NAMES[provider]}
    >
      <path d={icon.path} />
    </svg>
  );
}

export function IntegrationsTab() {
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const { data: integrations, isLoading } = useListIntegrations();
  const { mutate: deleteIntegration } = useDeleteIntegration();

  const statusMap = new Map(integrations?.map((s) => [s.provider, s]) ?? []);

  return (
    <div className="flex flex-col h-full">
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Loading...
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-1 py-1 custom-scrollbar">
          <div className="grid grid-cols-2 gap-2">
            {ALL_PROVIDERS.map((provider) => {
              const status = statusMap.get(provider);
              const connected = status?.connected ?? false;
              const displayName = status?.display_name ?? null;
              const source = status?.source ?? null;
              const isGhCli = source === "gh_cli";

              return (
                <div
                  key={provider}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors"
                >
                  <div className="relative shrink-0">
                    <ProviderIcon provider={provider} className="w-4 h-4 text-muted-foreground" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-background ${
                        connected ? "bg-emerald-500" : "bg-muted-foreground/40"
                      }`}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {PROVIDER_NAMES[provider] ?? provider}
                    </p>
                    {connected && (displayName || isGhCli) && (
                      <div className="flex items-center gap-1 mt-0.5">
                        {displayName && (
                          <p className="text-xs text-muted-foreground truncate">{displayName}</p>
                        )}
                        {isGhCli && (
                          <span className="text-xs text-muted-foreground bg-muted rounded px-1 shrink-0">
                            gh cli
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {connected ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-6 w-6"
                      disabled={isGhCli}
                      title={isGhCli ? "Managed by gh CLI" : `Disconnect ${PROVIDER_NAMES[provider]}`}
                      onClick={() => deleteIntegration(provider)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-6 w-6"
                      title={`Connect ${PROVIDER_NAMES[provider]}`}
                      onClick={() => setConnectProvider(provider)}
                    >
                      <Plus className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <IntegrationConnectDialog
        provider={connectProvider ?? ""}
        open={connectProvider !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setConnectProvider(null);
        }}
      />
    </div>
  );
}
