import { useState, useMemo } from "react";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import {
  useListIntegrations,
  PROVIDER_NAMES,
  PROVIDER_CAPABILITIES,
} from "@/services/integration.service";
import { GitHubRepoForm } from "./provider-forms/GithubRepoForm";
import { GitLabRepoForm } from "./provider-forms/GitlabRepoForm";
import { OwnerRepoForm } from "./provider-forms/OwnerRepoForm";
import { AzureDevOpsRepoForm } from "./provider-forms/AzureDevOpsRepoForm";
import { BitbucketRepoForm } from "./provider-forms/BitbucketRepoForm";

interface ProviderRepoPickerProps {
  onRepoSelected: (cloneUrl: string, repoName: string, provider?: string) => void;
  disabled?: boolean;
}

export function ProviderRepoPicker({ onRepoSelected, disabled }: ProviderRepoPickerProps) {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const integrationsQuery = useListIntegrations();

  const repoProviders = useMemo(() => {
    if (!integrationsQuery.data) return [];
    return integrationsQuery.data.filter(
      (i) => i.connected && PROVIDER_CAPABILITIES[i.provider]?.includes("repos"),
    );
  }, [integrationsQuery.data]);

  if (integrationsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        <Loader2 className="size-4 mr-2 animate-spin" />
        Loading providers…
      </div>
    );
  }

  if (repoProviders.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm leading-relaxed">
        No repo providers connected.
        <br />
        <span className="text-xs">
          Connect GitHub, GitLab or others in{" "}
          <strong className="text-foreground">Integrations</strong>.
        </span>
      </div>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex flex-wrap gap-2">
        {repoProviders.map((provider) => (
          <button
            key={provider.provider}
            type="button"
            disabled={disabled}
            onClick={() => setSelectedProvider(provider.provider)}
            className="flex flex-1 min-w-[120px] items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2.5 text-sm font-medium text-foreground hover:border-accent hover:bg-accent/5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <BrandIcon slug={provider.provider} width={18} height={18} />
            <span className="flex-1 text-left">{PROVIDER_NAMES[provider.provider]}</span>
            <span className="size-1.5 rounded-full bg-success shrink-0" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Selected provider card + X */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2.5 rounded-lg border border-accent bg-accent/10 px-3 py-2">
          <BrandIcon slug={selectedProvider} width={18} height={18} />
          <span className="text-sm font-medium">{PROVIDER_NAMES[selectedProvider]}</span>
          <span className="size-1.5 rounded-full bg-success shrink-0" />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setSelectedProvider(null)}
          aria-label="Change provider"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Provider-specific form */}
      <ProviderForm
        provider={selectedProvider}
        integration={repoProviders.find((p) => p.provider === selectedProvider) ?? null}
        onRepoSelected={onRepoSelected}
        disabled={disabled}
      />
    </div>
  );
}

interface ProviderFormProps {
  provider: string;
  integration: { display_name?: string | null; instance_url?: string | null } | null;
  onRepoSelected: (cloneUrl: string, repoName: string, provider?: string) => void;
  disabled?: boolean;
}

function ProviderForm({ provider, integration, onRepoSelected, disabled }: ProviderFormProps) {
  const withProvider = (url: string, name: string) => onRepoSelected(url, name, provider);

  switch (provider) {
    case "github":
      return (
        <GitHubRepoForm
          defaultOwner={integration?.display_name ?? undefined}
          onRepoSelected={withProvider}
          disabled={disabled}
        />
      );
    case "gitlab":
      return <GitLabRepoForm onRepoSelected={withProvider} disabled={disabled} />;
    case "forgejo":
      return <OwnerRepoForm provider="forgejo" onRepoSelected={withProvider} disabled={disabled} />;
    case "gitea":
      return <OwnerRepoForm provider="gitea" onRepoSelected={withProvider} disabled={disabled} />;
    case "azuredevops":
      return <AzureDevOpsRepoForm onRepoSelected={withProvider} disabled={disabled} />;
    case "bitbucket":
      return (
        <BitbucketRepoForm
          instanceUrl={integration?.instance_url ?? null}
          onRepoSelected={withProvider}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}
