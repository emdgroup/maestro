import { useState } from "react";
import { X, CircleDot, GitBranch } from "lucide-react";
import { Button } from "@/ui/button";
import {
  useListIntegrations,
  useDeleteIntegration,
  PROVIDER_NAMES,
  PROVIDER_CAPABILITIES,
} from "@/services/integration.service";
import { IntegrationConnectDialog } from "./IntegrationConnectDialog";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";

// Ordered as: row 1: Jira Cloud, Bitbucket | row 2: GitHub, GitLab | row 3: Gitea, Forgejo | row 4: Azure DevOps, Linear
const ALL_PROVIDERS = [
  "jira_cloud",
  "bitbucket",
  "github",
  "gitlab",
  "gitea",
  "forgejo",
  "azuredevops",
  "linear",
];

function CapabilityTag({ capability }: { capability: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground bg-muted rounded px-1">
      {capability === "issues" ? (
        <CircleDot className="w-2.5 h-2.5" />
      ) : (
        <GitBranch className="w-2.5 h-2.5" />
      )}
      {capability}
    </span>
  );
}

export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  return <BrandIcon slug={provider} className={className} width={28} height={28} />;
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
                  className={`flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors ${!connected ? "cursor-pointer" : ""}`}
                  onClick={!connected ? () => setConnectProvider(provider) : undefined}
                >
                  <div className="relative shrink-0">
                    <ProviderIcon provider={provider} className="w-7 h-7" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-background ${
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
                    <div className="flex gap-1 mt-0.5">
                      {(PROVIDER_CAPABILITIES[provider] ?? []).map((cap) => (
                        <CapabilityTag key={cap} capability={cap} />
                      ))}
                    </div>
                  </div>

                  {connected && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-6 w-6"
                      disabled={isGhCli}
                      title={
                        isGhCli ? "Managed by gh CLI" : `Disconnect ${PROVIDER_NAMES[provider]}`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteIntegration(provider);
                      }}
                    >
                      <X className="w-3 h-3" />
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
