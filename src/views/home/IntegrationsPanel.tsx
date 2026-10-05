import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  useListIntegrations,
  useDeleteIntegration,
  PROVIDER_NAMES,
  PROVIDER_CAPABILITIES,
} from "@/services/integration.service";
import type { IntegrationStatus } from "@/services/integration.service";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { cn } from "@/lib/utils";
import { IntegrationConnectDialog } from "@/views/project-picker/integrations-tab/IntegrationConnectDialog";
import { ChooseServiceDialog } from "./ChooseServiceDialog";
import { IntegrationDetailsDialog } from "./IntegrationDetailsDialog";

/** What a provider lets an agent work with, in the forge's own words. */
export function capabilityLabels(provider: string): string[] {
  return (PROVIDER_CAPABILITIES[provider] ?? []).map((capability) =>
    capability === "issues" ? "issues" : provider === "gitlab" ? "merge requests" : "pull requests",
  );
}

export function CapabilityTags({ provider }: { provider: string }) {
  return (
    <span className="flex gap-1">
      {capabilityLabels(provider).map((label) => (
        <span
          key={label}
          className="rounded-md bg-foreground/[0.07] px-1.5 py-px text-[10px] font-normal tracking-normal text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/** One tile per provider, in the order its first account was added. */
function groupByProvider(integrations: IntegrationStatus[]) {
  const groups = new Map<string, IntegrationStatus[]>();
  for (const integration of integrations) {
    groups.set(integration.provider, [...(groups.get(integration.provider) ?? []), integration]);
  }
  return [...groups.entries()];
}

/**
 * The Integrations panel of Home: a tile per provider, a hover card listing its accounts, and the
 * add flow. The card is shown by CSS on hover, so moving the pointer never re-renders anything;
 * clicking a tile pins its card until a click elsewhere, Escape, or a second click.
 */
export function IntegrationsPanel() {
  const { data: integrations = [] } = useListIntegrations();
  const { mutate: deleteIntegration } = useDeleteIntegration();
  const [pinned, setPinned] = useState<string | null>(null);
  const [details, setDetails] = useState<IntegrationStatus | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState<{ provider: string; fromChooser: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!pinned) return;
    const unpinOutside = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-integration-tile]")) setPinned(null);
    };
    const unpinOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(null);
    };
    document.addEventListener("pointerdown", unpinOutside);
    document.addEventListener("keydown", unpinOnEscape);
    return () => {
      document.removeEventListener("pointerdown", unpinOutside);
      document.removeEventListener("keydown", unpinOnEscape);
    };
  }, [pinned]);

  const openDetails = (integration: IntegrationStatus) => {
    setPinned(null);
    setDetails(integration);
  };
  const addAccount = (provider: string, fromChooser: boolean) => {
    setPinned(null);
    setChoosing(false);
    setConnecting({ provider, fromChooser });
  };

  return (
    <section id="integrations" className="home-glass relative z-10 rounded-[22px] p-5">
      <div className="text-sm font-medium">Integrations</div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        Issues and pull requests, for every connection
      </div>
      <div className="mt-4 flex gap-2.5">
        {groupByProvider(integrations).map(([provider, accounts]) => {
          const name = PROVIDER_NAMES[provider] ?? provider;
          const isPinned = pinned === provider;
          return (
            <span key={provider} data-integration-tile className="group/tile relative">
              <button
                type="button"
                aria-label={name}
                aria-expanded={isPinned}
                onClick={() => setPinned(isPinned ? null : provider)}
                className={cn(
                  "home-pane relative grid h-[42px] w-[42px] cursor-pointer place-items-center rounded-xl",
                  "group-hover/tile:-translate-y-0.5 group-hover/tile:border-accent/60",
                  isPinned && "-translate-y-0.5 border-accent/60 ring-2 ring-accent/35",
                )}
              >
                <BrandIcon slug={provider} className="size-5" />
                {accounts.length > 1 && (
                  <span className="absolute -top-[5px] -right-[5px] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-[5px] text-[10px] font-semibold text-background tabular-nums">
                    {accounts.length}
                  </span>
                )}
              </button>
              {/* The top padding bridges the gap to the tile, so the pointer can cross onto the card. */}
              <div
                className={cn(
                  "absolute top-[42px] -left-2 z-20 pt-2",
                  isPinned ? "block" : pinned ? "hidden" : "hidden group-hover/tile:block",
                )}
              >
                <div className="home-pop w-72 animate-in rounded-2xl p-1.5 text-sm fade-in-0 zoom-in-95">
                  <div className="flex items-baseline px-2.5 pt-1.5 pb-1">
                    <span className="text-xs font-medium">{name}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {accounts.length} account{accounts.length > 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="mx-2.5 mb-1.5">
                    <CapabilityTags provider={provider} />
                  </div>
                  {accounts.map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => openDetails(account)}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-foreground/[0.07]"
                    >
                      <BrandIcon slug={provider} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {account.display_name ?? name}
                          {account.source === "gh_cli" && (
                            <span className="ml-1 rounded-md bg-foreground/[0.07] px-1.5 py-px text-[10px] font-normal text-muted-foreground">
                              gh cli
                            </span>
                          )}
                        </span>
                        {account.instance_url && (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {account.instance_url}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">›</span>
                    </button>
                  ))}
                  <div className="my-1 h-px bg-foreground/10" />
                  <button
                    type="button"
                    onClick={() => addAccount(provider, false)}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-foreground/[0.07]"
                  >
                    <Plus className="size-4" />
                    Add another {name} account
                  </button>
                </div>
              </div>
            </span>
          );
        })}
        <button
          type="button"
          id="add-integration"
          aria-label="Add an integration"
          onClick={() => setChoosing(true)}
          className="home-ghost grid h-[42px] w-[42px] cursor-pointer place-items-center rounded-xl text-muted-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <ChooseServiceDialog
        open={choosing}
        onOpenChange={setChoosing}
        onChoose={(provider) => addAccount(provider, true)}
      />
      <IntegrationConnectDialog
        provider={connecting?.provider ?? ""}
        open={connecting !== null}
        onOpenChange={(open) => {
          if (!open) setConnecting(null);
        }}
        onBack={
          connecting?.fromChooser
            ? () => {
                setConnecting(null);
                setChoosing(true);
              }
            : undefined
        }
        onSuccess={() => setConnecting(null)}
        contentClassName="home-pop rounded-[22px] bg-transparent ring-0"
        overlayClassName="home-scrim bg-transparent supports-backdrop-filter:backdrop-blur-none"
      />
      <IntegrationDetailsDialog
        integration={details}
        onClose={() => setDetails(null)}
        onDisconnect={(integration) => {
          deleteIntegration({ provider: integration.provider, id: integration.id });
          setDetails(null);
        }}
      />
    </section>
  );
}
