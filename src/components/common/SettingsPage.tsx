import { useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { BrandIcon, hasBrandIcon } from "@/components/common/BrandIcon";
import { useForm, Controller } from "react-hook-form";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Button } from "@/ui/button";
import { Bot, CircleDot } from "lucide-react";
import { IssueTrackingProviderForm } from "@/components/common/settings/IssueTrackingProviderForm";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useAgentDiscoveryQuery, useAgentCacheQuery } from "@/services/execution.service";
import {
  useListIntegrations,
  useProjectIssueTrackingConfig,
  useSaveProjectIssueTrackingConfig,
  PROVIDER_NAMES,
} from "@/services/integration.service";
import type { ProjectIssueTrackingConfig } from "@/types/bindings";
import { showSuccessToast } from "./ErrorToast";

interface SettingsPageProps {
  projectId: number;
  connectionId: number | null;
  wslConnectionId?: number | null;
}

interface ProjectSettingsFormData {
  default_agent: string;
  default_model: string;
}

export interface SettingsPageHandle {
  save: () => Promise<void>;
  resetToDefaults: () => void;
}

export const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(
  ({ projectId, connectionId, wslConnectionId }, ref) => {
    const { control, handleSubmit, watch, setValue, reset } = useForm<ProjectSettingsFormData>({
      defaultValues: { default_agent: "", default_model: "" },
    });

    const selectedAgent = watch("default_agent");

    const projectSettingsQuery = useProjectSettings(projectId);
    const updateProjectSettingsMutation = useUpdateProjectSettings();
    const { data: discovery, isLoading: agentsLoading } = useAgentDiscoveryQuery(
      connectionId,
      wslConnectionId ?? null,
    );
    const { data: agentCache, isLoading: cacheLoading } = useAgentCacheQuery(
      projectId,
      selectedAgent || null,
    );

    const { data: integrations } = useListIntegrations();
    const projectIssueTrackingQuery = useProjectIssueTrackingConfig(projectId);
    const saveIssueTrackingMutation = useSaveProjectIssueTrackingConfig();

    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
    const [issueTrackingFields, setIssueTrackingFields] = useState<Record<string, string>>({});
    const [issueTrackingConfigured, setIssueTrackingConfigured] = useState(false);
    const [issueTrackingEditing, setIssueTrackingEditing] = useState(false);

    useEffect(() => {
      if (!projectSettingsQuery.data) return;
      const { default_agent, default_model } = projectSettingsQuery.data;
      reset({
        default_agent: default_agent ?? "",
        default_model: default_model ?? "",
      });
    }, [projectSettingsQuery.data, reset]);

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

    // When agent changes, clear model selection
    const handleAgentChange = (value: string | null) => {
      setValue("default_agent", value ?? "");
      setValue("default_model", "");
    };

    const availableModels = agentCache?.config_options.find((o) => o.id === "model")?.options ?? [];

    const onSubmit = async (data: ProjectSettingsFormData) => {
      try {
        await updateProjectSettingsMutation.mutateAsync({
          projectId,
          config: {
            default_agent: data.default_agent || null,
            default_model: data.default_model || null,
          },
        });
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
        showSuccessToast("Settings saved");
      } catch (err) {
        console.error("Failed to save project settings:", err);
      }
    };

    useImperativeHandle(ref, () => ({
      save: async () => {
        await handleSubmit(onSubmit)();
      },
      resetToDefaults: () => {
        reset({ default_agent: "", default_model: "" });
      },
    }));

    const agents = discovery?.agents ?? [];
    const isLoading = projectSettingsQuery.isLoading;

    // Providers that only host repos and do not support issue tracking in Maestro.
    const reposOnlyProviders = new Set(["bitbucket"]);

    const connectedIntegrations = integrations?.filter((s) => s.connected) ?? [];
    const issueTrackingIntegrations = connectedIntegrations.filter(
      (s) => !reposOnlyProviders.has(s.provider),
    );

    return (
      <div className="h-full">
        <div className="max-w-3xl mx-auto p-6">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure the default agent and model for new sessions in this project
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading settings...
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              <div className="bg-card border border-border rounded-lg p-4 space-y-4">
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <Bot className="w-4 h-4 text-muted-foreground" />
                  Agent &amp; Model
                </h3>

                {/* Default Agent */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Default Agent</Label>
                  <Controller
                    name="default_agent"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={handleAgentChange}
                        disabled={agentsLoading}
                      >
                        <SelectTrigger className="w-full bg-muted">
                          <SelectValue
                            placeholder={
                              agentsLoading ? "Loading agents…" : "None (use session default)"
                            }
                          >
                            {field.value === ""
                              ? "None (use session default)"
                              : (agents.find((a) => a.id === field.value)?.name ?? field.value)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None (use session default)</SelectItem>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              <div className="flex items-center gap-2">
                                {hasBrandIcon(agent.id) ? (
                                  <BrandIcon slug={agent.id} className="w-4 h-4 shrink-0" />
                                ) : (
                                  agent.icon && (
                                    <img
                                      src={agent.icon}
                                      className="w-4 h-4 rounded-sm shrink-0 dark:[filter:invert(1)]"
                                      onError={(e) => {
                                        (e.currentTarget as HTMLImageElement).style.display =
                                          "none";
                                      }}
                                    />
                                  )
                                )}
                                {agent.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    Used for new sessions and auto-assigned tasks
                  </p>
                </div>

                {/* Default Model */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Default Model</Label>
                  <div className="flex gap-2">
                    <Controller
                      name="default_model"
                      control={control}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={!selectedAgent || cacheLoading || availableModels.length === 0}
                        >
                          <SelectTrigger className="flex-1 bg-muted">
                            <SelectValue
                              placeholder={
                                !selectedAgent
                                  ? "Select an agent first"
                                  : cacheLoading
                                    ? "Loading…"
                                    : availableModels.length === 0
                                      ? "No models cached yet"
                                      : "Select a model"
                              }
                            >
                              {field.value === ""
                                ? "Agent default"
                                : (availableModels.find((m) => m.value === field.value)?.name ??
                                  field.value)}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Agent default</SelectItem>
                            {availableModels.map((model) => (
                              <SelectItem key={model.value} value={model.value}>
                                {model.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  {!selectedAgent && (
                    <p className="text-xs text-muted-foreground">
                      Select an agent to enable model selection
                    </p>
                  )}
                  {selectedAgent && availableModels.length === 0 && !cacheLoading && (
                    <p className="text-xs text-muted-foreground">
                      Spawn a session with this agent to populate the model list
                    </p>
                  )}
                </div>
              </div>

              {/* Issue Tracking Card */}
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
                          onClick={() => setSelectedProvider(integration.provider)}
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
                        onFieldsChange={setIssueTrackingFields}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={updateProjectSettingsMutation.isPending}>
                  {updateProjectSettingsMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  },
);

SettingsPage.displayName = "SettingsPage";
