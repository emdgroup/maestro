import { useState } from "react";
import { CircleDot, Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { IssueTrackingProviderForm } from "@/views/settings/issue-tracking-forms/IssueTrackingProviderForm";
import { IntegrationConnectDialog } from "@/views/project-picker/integrations-tab/IntegrationConnectDialog";
import {
  useDetectIssueTracking,
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

function fieldsFromConfig(config: ProjectIssueTrackingConfig): Record<string, string> {
  return {
    owner: config.owner ?? "",
    repo: config.repo ?? "",
    project_path: config.project_path ?? "",
    team_id: config.team_id ?? "",
    project_key: config.project_key ?? "",
    project_name: config.project_name ?? "",
  };
}

/** What the git remote pointed at, for the "detected from your git remote" line. */
function describeTarget(config: ProjectIssueTrackingConfig): string | null {
  if (config.owner && config.repo) return `${config.owner}/${config.repo}`;
  return config.project_path ?? config.project_name ?? null;
}

interface IssueTrackingSectionProps {
  projectId: number;
  issueTrackingIntegrations: IntegrationStatus[];
}

export function IssueTrackingSection({
  projectId,
  issueTrackingIntegrations,
}: IssueTrackingSectionProps) {
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [issueTrackingFields, setIssueTrackingFields] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  // What is on disk. The blur handler below fires on every focus change inside the provider
  // form, including tabbing through fields without editing them.
  const [persisted, setPersisted] = useState("");

  const projectIssueTrackingQuery = useProjectIssueTrackingConfig(projectId);
  const saveIssueTrackingMutation = useSaveProjectIssueTrackingConfig();
  const { data: detected } = useDetectIssueTracking(projectId);

  // Only offered while nothing is configured — once a provider is connected the detected
  // config has either been applied already or the user picked something else on purpose.
  const detectedUnconnected =
    detected && !detected.connected && !projectIssueTrackingQuery.data ? detected : null;

  const selectedIntegration =
    issueTrackingIntegrations.find((i) => i.id === selectedIntegrationId) ?? null;

  // A different project starts from a blank form; the query effect below then fills it
  // from that project's stored config. Adjusted during render rather than from an effect
  // so the new project never paints the previous one's selection.
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId);
    setSelectedIntegrationId(null);
    setIssueTrackingFields({});
    setPersisted("");
  }

  // Populate the form from the project's stored config once the query resolves. Adjusted
  // during render rather than from an effect so the settings page never paints an empty
  // form over a config it already has.
  // Latched on the resolved match as well as the config, so a config that arrives before
  // the integrations list still selects its integration once that list lands.
  const storedConfig = projectIssueTrackingQuery.data ?? null;
  const matchedIntegrationId = storedConfig
    ? ((
        issueTrackingIntegrations.find((i) => i.id === storedConfig.integration_id) ??
        issueTrackingIntegrations.find((i) => i.provider === storedConfig.provider)
      )?.id ?? null)
    : null;
  const [loaded, setLoaded] = useState({ config: storedConfig, matchId: matchedIntegrationId });
  if (loaded.config !== storedConfig || loaded.matchId !== matchedIntegrationId) {
    setLoaded({ config: storedConfig, matchId: matchedIntegrationId });
    if (storedConfig) {
      if (matchedIntegrationId) setSelectedIntegrationId(matchedIntegrationId);
      setIssueTrackingFields(fieldsFromConfig(storedConfig));
      setPersisted(JSON.stringify(storedConfig));
    }
  }

  /// There is no Save button: the config persists as it is filled in.
  ///
  /// Only once every field the provider needs is present — a half-filled config would be stored
  /// and then fail at the first `list_remote_issues`, which is worse than not storing it yet.
  /// The integration and fields are passed in because a handler that just called `setState` still
  /// sees the previous render's values.
  function saveNow(
    integration: { id: string; provider: string } | null,
    fields: Record<string, string>,
  ) {
    if (!integration) return;
    if (!getRequiredIntegrationFields(integration.provider).every((f) => fields[f]?.trim())) return;

    const config: ProjectIssueTrackingConfig = {
      provider: integration.provider,
      integration_id: integration.id,
      owner: fields.owner || null,
      repo: fields.repo || null,
      project_path: fields.project_path || null,
      team_id: fields.team_id || null,
      project_key: fields.project_key || null,
      project_name: fields.project_name || null,
    };
    const next = JSON.stringify(config);
    if (next === persisted) return;
    setPersisted(next);
    saveIssueTrackingMutation.mutate({ projectId, issueTracking: config });
  }

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
          {detectedUnconnected && (
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-border/70 p-3">
              <BrandIcon slug={detectedUnconnected.provider} className="w-5 h-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {PROVIDER_NAMES[detectedUnconnected.provider] ?? detectedUnconnected.provider}{" "}
                  detected from this project&apos;s git remote
                </p>
                {describeTarget(detectedUnconnected.config) && (
                  <p className="text-xs text-muted-foreground truncate">
                    {describeTarget(detectedUnconnected.config)} — connect an account to load its
                    issues
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setConnectProvider(detectedUnconnected.provider)}
              >
                Connect
              </Button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {issueTrackingIntegrations.map((integration) => (
              <button
                key={integration.id}
                type="button"
                onClick={() => {
                  setSelectedIntegrationId(integration.id);
                  setPickerOpen(false);
                  // Persists straight away for a provider that needs no extra fields (Linear);
                  // for the rest `saveNow` waits until the form below is complete.
                  saveNow(integration, issueTrackingFields);
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
              onClick={() => setPickerOpen((open) => !open)}
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
          {/* React's `onBlur` is `focusout`, which bubbles — one handler covers every field the
              provider form renders without each of them having to know how to save. */}
          <div onBlur={() => saveNow(selectedIntegration, issueTrackingFields)}>
            <IssueTrackingProviderForm
              provider={selectedIntegration.provider}
              integration={selectedIntegration}
              fields={issueTrackingFields}
              onFieldsChange={setIssueTrackingFields}
              // Shown from the moment a provider is picked: with no Save button to press, an
              // unmarked empty field is the only thing between the user and silent non-persistence.
              showValidation
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              await saveIssueTrackingMutation.mutateAsync({ projectId, issueTracking: null });
              setPersisted("");
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
          let fields = issueTrackingFields;
          if (detected && detected.provider === connectProvider) {
            fields = fieldsFromConfig(detected.config);
            setIssueTrackingFields(fields);
          }
          // Saved from the id and provider to hand rather than waiting for the integrations list
          // to refetch — the newly connected account is not in it yet, so `selectedIntegration`
          // is still null on this render.
          if (connectProvider) saveNow({ id, provider: connectProvider }, fields);
          setConnectProvider(null);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}
