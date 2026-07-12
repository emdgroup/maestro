import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { CircleDot, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { IssueTrackingProviderForm } from "@/views/settings/issue-tracking-forms/IssueTrackingProviderForm";
import { IntegrationConnectDialog } from "@/views/project-picker/integrations-tab/IntegrationConnectDialog";
import {
  useProjectIssueTrackingConfig,
  useSaveProjectIssueTrackingConfig,
  PROVIDER_NAMES,
} from "@/services/integration.service";
import type { IntegrationStatus, ProjectIssueTrackingConfig } from "@/types/bindings";

const ISSUE_PROVIDERS = [
  "jira_cloud",
  "github",
  "gitlab",
  "gitea",
  "forgejo",
  "azuredevops",
  "linear",
];

function getRequiredIntegrationFields(provider: string): string[] {
  switch (provider) {
    case "github":
    case "forgejo":
    case "gitea":
      return ["owner", "repo"];
    case "gitlab":
      return ["project_path"];
    case "jira_cloud":
      return ["project_key"];
    case "azuredevops":
      return ["project_name"];
    default:
      return [];
  }
}

export interface IssueTrackingSectionHandle {
  save: () => Promise<void>;
  isValid: () => boolean;
  setAttempted: (v: boolean) => void;
}

interface IssueTrackingSectionProps {
  projectId: number;
  issueTrackingIntegrations: IntegrationStatus[];
  onValidityChange: (valid: boolean) => void;
}

export const IssueTrackingSection = forwardRef<
  IssueTrackingSectionHandle,
  IssueTrackingSectionProps
>(({ projectId, issueTrackingIntegrations, onValidityChange }, ref) => {
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [issueTrackingFields, setIssueTrackingFields] = useState<Record<string, string>>({});
  const [issueTrackingAttempted, setIssueTrackingAttempted] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);

  const projectIssueTrackingQuery = useProjectIssueTrackingConfig(projectId);
  const saveIssueTrackingMutation = useSaveProjectIssueTrackingConfig();

  const selectedIntegration =
    issueTrackingIntegrations.find((i) => i.id === selectedIntegrationId) ?? null;

  const isIssueTrackingValid =
    !selectedIntegration ||
    getRequiredIntegrationFields(selectedIntegration.provider).every((f) =>
      issueTrackingFields[f]?.trim(),
    );

  useEffect(() => {
    onValidityChange(isIssueTrackingValid);
  }, [isIssueTrackingValid, onValidityChange]);

  useEffect(() => {
    setSelectedIntegrationId(null);
    setIssueTrackingFields({});
  }, [projectId]);

  useEffect(() => {
    if (!projectIssueTrackingQuery.data) return;
    const config = projectIssueTrackingQuery.data;
    const match =
      issueTrackingIntegrations.find((i) => i.id === config.integration_id) ??
      issueTrackingIntegrations.find((i) => i.provider === config.provider) ??
      null;
    if (match) setSelectedIntegrationId(match.id);
    setIssueTrackingFields({
      owner: config.owner ?? "",
      repo: config.repo ?? "",
      project_path: config.project_path ?? "",
      team_id: config.team_id ?? "",
      project_key: config.project_key ?? "",
      project_name: config.project_name ?? "",
    });
  }, [projectIssueTrackingQuery.data, issueTrackingIntegrations]);

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (selectedIntegration) {
        const config: ProjectIssueTrackingConfig = {
          provider: selectedIntegration.provider,
          integration_id: selectedIntegrationId,
          owner: issueTrackingFields.owner || null,
          repo: issueTrackingFields.repo || null,
          project_path: issueTrackingFields.project_path || null,
          team_id: issueTrackingFields.team_id || null,
          project_key: issueTrackingFields.project_key || null,
          project_name: issueTrackingFields.project_name || null,
        };
        await saveIssueTrackingMutation.mutateAsync({ projectId, issueTracking: config });
      }
      setIssueTrackingAttempted(false);
    },
    isValid: () => isIssueTrackingValid,
    setAttempted: (v: boolean) => setIssueTrackingAttempted(v),
  }));

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <CircleDot className="w-4 h-4 text-muted-foreground" />
        Issue Tracking
      </h3>

      {/* When integration selected: show only that chip. When unset: show all chips + Add + picker. */}
      {selectedIntegration ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary ring-2 ring-primary bg-primary/5 cursor-default"
          >
            <div className="relative shrink-0">
              <BrandIcon slug={selectedIntegration.provider} className="w-4 h-4" />
              <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
            </div>
            <span className="text-sm font-medium">
              {selectedIntegration.display_name ??
                PROVIDER_NAMES[selectedIntegration.provider] ??
                selectedIntegration.provider}
            </span>
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {issueTrackingIntegrations.map((integration) => (
              <button
                key={integration.id}
                type="button"
                onClick={() => {
                  setSelectedIntegrationId(integration.id);
                  setPickerOpen(false);
                  setIssueTrackingAttempted(false);
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-card hover:bg-muted/50 transition-colors"
              >
                <div className="relative shrink-0">
                  <BrandIcon slug={integration.provider} className="w-4 h-4" />
                  <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
                </div>
                <span className="text-sm font-medium">
                  {integration.display_name ??
                    PROVIDER_NAMES[integration.provider] ??
                    integration.provider}
                </span>
              </button>
            ))}

            <button
              type="button"
              onClick={() => {
                setPickerOpen((open) => !open);
                setIssueTrackingAttempted(false);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-colors ${
                pickerOpen
                  ? "border-primary bg-primary/5"
                  : "border-dashed border-border/70 text-muted-foreground hover:border-accent hover:text-accent"
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-sm">Add</span>
            </button>
          </div>

          {pickerOpen && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground mb-2">Select a provider to connect</p>
              <div className="grid grid-cols-4 gap-2">
                {ISSUE_PROVIDERS.map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => setConnectProvider(provider)}
                    className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-border bg-card hover:bg-muted/50 hover:border-accent transition-colors"
                  >
                    <BrandIcon slug={provider} className="w-6 h-6" />
                    <span className="text-xs font-medium text-center leading-tight">
                      {PROVIDER_NAMES[provider] ?? provider}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Provider form when chip is selected */}
      {selectedIntegration && (
        <div className="space-y-3">
          <IssueTrackingProviderForm
            provider={selectedIntegration.provider}
            integration={selectedIntegration}
            fields={issueTrackingFields}
            onFieldsChange={(f) => {
              setIssueTrackingFields(f);
              setIssueTrackingAttempted(false);
            }}
            showValidation={issueTrackingAttempted}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              await saveIssueTrackingMutation.mutateAsync({ projectId, issueTracking: null });
              setSelectedIntegrationId(null);
              setIssueTrackingFields({});
            }}
            disabled={saveIssueTrackingMutation.isPending}
          >
            Remove
          </Button>
        </div>
      )}

      <IntegrationConnectDialog
        provider={connectProvider ?? ""}
        open={connectProvider !== null}
        onOpenChange={(open) => {
          if (!open) setConnectProvider(null);
        }}
        onSuccess={(id) => {
          setSelectedIntegrationId(id);
          setConnectProvider(null);
          setPickerOpen(false);
        }}
      />
    </div>
  );
});

IssueTrackingSection.displayName = "IssueTrackingSection";
