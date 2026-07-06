import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { Button } from "@/ui/button";
import { CircleDot } from "lucide-react";
import { IssueTrackingProviderForm } from "@/views/settings/issue-tracking-forms/IssueTrackingProviderForm";
import {
  useProjectIssueTrackingConfig,
  useSaveProjectIssueTrackingConfig,
  PROVIDER_NAMES,
} from "@/services/integration.service";
import type { IntegrationStatus, ProjectIssueTrackingConfig } from "@/types/bindings";

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

export const IssueTrackingSection = forwardRef<IssueTrackingSectionHandle, IssueTrackingSectionProps>(
  ({ projectId, issueTrackingIntegrations, onValidityChange }, ref) => {
    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
    const [issueTrackingFields, setIssueTrackingFields] = useState<Record<string, string>>({});
    const [issueTrackingConfigured, setIssueTrackingConfigured] = useState(false);
    const [issueTrackingEditing, setIssueTrackingEditing] = useState(false);
    const [issueTrackingAttempted, setIssueTrackingAttempted] = useState(false);

    const projectIssueTrackingQuery = useProjectIssueTrackingConfig(projectId);
    const saveIssueTrackingMutation = useSaveProjectIssueTrackingConfig();

    const isIssueTrackingValid =
      !selectedProvider ||
      getRequiredIntegrationFields(selectedProvider).every((f) => issueTrackingFields[f]?.trim());

    useEffect(() => {
      onValidityChange(isIssueTrackingValid);
    }, [isIssueTrackingValid, onValidityChange]);

    useEffect(() => {
      if (!projectIssueTrackingQuery.data) {
        setIssueTrackingConfigured(false);
        setSelectedProvider(null);
        setIssueTrackingFields({});
        return;
      }
      const config = projectIssueTrackingQuery.data;
      setIssueTrackingConfigured(true);
      setSelectedProvider(config.provider);
      setIssueTrackingFields({
        owner: config.owner ?? "",
        repo: config.repo ?? "",
        project_path: config.project_path ?? "",
        team_id: config.team_id ?? "",
        project_key: config.project_key ?? "",
        project_name: config.project_name ?? "",
      });
    }, [projectIssueTrackingQuery.data]);

    useImperativeHandle(ref, () => ({
      save: async () => {
        if (selectedProvider) {
          const config: ProjectIssueTrackingConfig = {
            provider: selectedProvider,
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

        {issueTrackingIntegrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No integrations connected. Add integrations from the project picker screen.
          </p>
        ) : issueTrackingConfigured && !issueTrackingEditing ? (
          /* State C: Configured read-only */
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {issueTrackingIntegrations.map((integration) => (
                <div
                  key={integration.provider}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-default ${
                    integration.provider === selectedProvider
                      ? "border-primary ring-2 ring-primary bg-primary/5"
                      : "border-border bg-muted/30 opacity-50"
                  }`}
                >
                  <span className="text-sm font-medium">
                    {PROVIDER_NAMES[integration.provider] ?? integration.provider}
                  </span>
                </div>
              ))}
            </div>
            {selectedProvider && Object.values(issueTrackingFields).some(Boolean) && (
              <div className="space-y-1">
                {Object.entries(issueTrackingFields)
                  .filter(([, v]) => v)
                  .map(([key, value]) => (
                    <p key={key} className="text-sm text-muted-foreground">
                      {value}
                    </p>
                  ))}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIssueTrackingEditing(true)}
              >
                Change
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await saveIssueTrackingMutation.mutateAsync({
                    projectId,
                    issueTracking: null,
                  });
                  setIssueTrackingConfigured(false);
                  setSelectedProvider(null);
                  setIssueTrackingFields({});
                  setIssueTrackingEditing(false);
                }}
                disabled={saveIssueTrackingMutation.isPending}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : (
          /* State B: Picker (not configured or editing) */
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {issueTrackingIntegrations.map((integration) => (
                <button
                  key={integration.provider}
                  type="button"
                  onClick={() => {
                    setSelectedProvider(integration.provider);
                    setIssueTrackingAttempted(false);
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                    selectedProvider === integration.provider
                      ? "border-primary ring-2 ring-primary bg-primary/5"
                      : "border-border bg-card hover:bg-muted/50 opacity-70 hover:opacity-100"
                  }`}
                >
                  <span className="text-sm font-medium">
                    {PROVIDER_NAMES[integration.provider] ?? integration.provider}
                  </span>
                </button>
              ))}
            </div>
            {selectedProvider && (
              <IssueTrackingProviderForm
                provider={selectedProvider}
                integration={
                  issueTrackingIntegrations.find((i) => i.provider === selectedProvider)!
                }
                fields={issueTrackingFields}
                onFieldsChange={(f) => {
                  setIssueTrackingFields(f);
                  setIssueTrackingAttempted(false);
                }}
                showValidation={issueTrackingAttempted}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);

IssueTrackingSection.displayName = "IssueTrackingSection";
