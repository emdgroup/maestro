import { useState } from "react";
import { Plus, CircleDot, GitBranch } from "lucide-react";
import {
  useListIntegrations,
  useDeleteIntegration,
  PROVIDER_NAMES,
  PROVIDER_CAPABILITIES,
} from "@/services/integration.service";
import type { IntegrationStatus } from "@/services/integration.service";
import { IntegrationConnectDialog } from "./IntegrationConnectDialog";
import { IntegrationDetailModal } from "./IntegrationDetailModal";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { PanelHeader } from "@/views/project-picker/connection-list/PanelHeader";

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

type Screen = "list" | "provider-picker";

export function IntegrationsTab() {
  const [screen, setScreen] = useState<Screen>("list");
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const [detailIntegration, setDetailIntegration] = useState<IntegrationStatus | null>(null);
  const { data: integrations = [], isLoading } = useListIntegrations();
  const { mutate: deleteIntegration } = useDeleteIntegration();

  const panelOffset = screen === "list" ? 0 : -50;

  return (
    <>
      <div className="h-full overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-in-out"
          style={{ width: "200%", transform: `translateX(${panelOffset}%)` }}
        >
          {/* Panel 0 — integration list */}
          <div className="w-1/2 h-full flex flex-col min-w-0">
            {isLoading ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Loading...
              </div>
            ) : (
              <div className="flex-1 overflow-auto px-1 py-1 custom-scrollbar">
                <ul className="space-y-2">
                  {integrations.map((integration) => (
                    <li key={integration.id}>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-card hover:bg-muted/50 hover:border-accent transition-colors text-left group"
                        onClick={() => setDetailIntegration(integration)}
                      >
                        <div className="relative shrink-0">
                          <BrandIcon slug={integration.provider} className="w-7 h-7" />
                          <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-background" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium group-hover:text-accent transition-colors">
                            {PROVIDER_NAMES[integration.provider] ?? integration.provider}
                          </p>
                          {integration.display_name && (
                            <p className="text-xs text-muted-foreground truncate">
                              {integration.display_name}
                              {integration.source === "gh_cli" && (
                                <span className="ml-1 bg-muted rounded px-1">gh cli</span>
                              )}
                            </p>
                          )}
                          <div className="flex gap-1 mt-0.5">
                            {(PROVIDER_CAPABILITIES[integration.provider] ?? []).map((cap) => (
                              <CapabilityTag key={cap} capability={cap} />
                            ))}
                          </div>
                        </div>

                        <span className="text-muted-foreground shrink-0 text-xs">›</span>
                      </button>
                    </li>
                  ))}

                  <li key="add">
                    <button
                      type="button"
                      onClick={() => setScreen("provider-picker")}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border/50 text-muted-foreground hover:border-accent hover:text-accent transition-colors"
                    >
                      <Plus className="w-4 h-4 shrink-0" />
                      <span className="text-sm">Add integration</span>
                    </button>
                  </li>
                </ul>
              </div>
            )}
          </div>

          {/* Panel 1 — provider picker */}
          <div className="w-1/2 h-full flex flex-col min-w-0">
            <PanelHeader onBack={() => setScreen("list")} title="Add integration" />
            <div className="flex-1 overflow-auto p-2 custom-scrollbar">
              <div className="grid grid-cols-2 gap-2">
                {ALL_PROVIDERS.map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted/50 hover:border-accent transition-colors text-left"
                    onClick={() => setConnectProvider(provider)}
                  >
                    <BrandIcon slug={provider} className="w-7 h-7 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {PROVIDER_NAMES[provider] ?? provider}
                      </p>
                      <div className="flex gap-1 mt-0.5">
                        {(PROVIDER_CAPABILITIES[provider] ?? []).map((cap) => (
                          <CapabilityTag key={cap} capability={cap} />
                        ))}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <IntegrationConnectDialog
        provider={connectProvider ?? ""}
        open={connectProvider !== null}
        onOpenChange={(open) => {
          if (!open) setConnectProvider(null);
        }}
        onSuccess={(_id) => {
          setConnectProvider(null);
          setScreen("list");
        }}
      />

      <IntegrationDetailModal
        integration={detailIntegration}
        open={detailIntegration !== null}
        onOpenChange={(open) => {
          if (!open) setDetailIntegration(null);
        }}
        onDisconnect={(integration) => {
          deleteIntegration({ provider: integration.provider, id: integration.id });
          setDetailIntegration(null);
        }}
      />
    </>
  );
}
