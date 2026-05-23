import { useState } from "react";
import { Globe, Plus, X } from "lucide-react";
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

const ALL_PROVIDERS = Object.keys(PROVIDER_NAMES);

export function IntegrationsTab() {
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const { data: integrations, isLoading } = useListIntegrations();
  const { mutate: deleteIntegration } = useDeleteIntegration();

  const statusMap = new Map(integrations?.map((s) => [s.provider, s]) ?? []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Globe className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Integrations</h2>
      </div>

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
                    <Globe className="w-4 h-4 text-muted-foreground" />
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
                    {connected && displayName && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <p className="text-xs text-muted-foreground truncate">{displayName}</p>
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
