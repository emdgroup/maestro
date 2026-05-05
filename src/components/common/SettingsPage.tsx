import { useEffect, forwardRef, useImperativeHandle } from "react";
import { useForm, Controller } from "react-hook-form";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Button } from "@/ui/button";
import { Bot, RefreshCw } from "lucide-react";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import {
  useAgentDiscoveryQuery,
  useAgentModelsCacheQuery,
  useRefreshAgentModelsMutation,
} from "@/services/execution.service";
import { showSuccessToast } from "./ErrorToast";

interface SettingsPageProps {
  projectId: number;
  connectionId: number | null;
}

interface ProjectSettingsFormData {
  default_agent: string;
  default_model: string;
}

export interface SettingsPageHandle {
  save: () => Promise<void>;
  resetToDefaults: () => void;
}

const CACHE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(
  ({ projectId, connectionId }, ref) => {
    const { control, handleSubmit, watch, setValue, reset } = useForm<ProjectSettingsFormData>({
      defaultValues: { default_agent: "", default_model: "" },
    });

    const selectedAgent = watch("default_agent");

    const projectSettingsQuery = useProjectSettings(projectId);
    const updateProjectSettingsMutation = useUpdateProjectSettings();
    const { data: discovery, isLoading: agentsLoading } = useAgentDiscoveryQuery(connectionId);
    const { data: modelsCache, isLoading: cacheLoading } = useAgentModelsCacheQuery(
      projectId,
      selectedAgent || null,
    );
    const refreshMutation = useRefreshAgentModelsMutation();

    useEffect(() => {
      if (!projectSettingsQuery.data) return;
      const { default_agent, default_model } = projectSettingsQuery.data;
      reset({
        default_agent: default_agent ?? "",
        default_model: default_model ?? "",
      });
    }, [projectSettingsQuery.data, reset]);

    // When agent changes, clear model selection
    const handleAgentChange = (value: string | null) => {
      setValue("default_agent", value ?? "");
      setValue("default_model", "");
    };

    const cacheAge = modelsCache?.fetched_at
      ? Date.now() - Date.parse(modelsCache.fetched_at)
      : Infinity;
    const isStale = cacheAge > CACHE_MAX_AGE_MS;
    const showRefresh = selectedAgent && (!modelsCache || isStale);
    const availableModels = modelsCache?.models ?? [];

    const onSubmit = async (data: ProjectSettingsFormData) => {
      try {
        await updateProjectSettingsMutation.mutateAsync({
          projectId,
          config: {
            default_agent: data.default_agent || null,
            default_model: data.default_model || null,
          },
        });
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
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None (use session default)</SelectItem>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              <div className="flex items-center gap-2">
                                {agent.icon && (
                                  <img
                                    src={agent.icon}
                                    className="w-4 h-4 rounded-sm shrink-0 brightness-0 dark:invert"
                                    onError={(e) => {
                                      (e.currentTarget as HTMLImageElement).style.display = "none";
                                    }}
                                  />
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
                                      ? "No models cached — click Refresh"
                                      : "Select a model"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Agent default</SelectItem>
                            {availableModels.map((model) => (
                              <SelectItem key={model.model_id} value={model.model_id}>
                                {model.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                    {showRefresh && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={refreshMutation.isPending}
                        onClick={() =>
                          refreshMutation.mutate({ projectId, agentId: selectedAgent })
                        }
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${refreshMutation.isPending ? "animate-spin" : ""}`}
                        />
                        <span className="ml-1.5">
                          {refreshMutation.isPending ? "Fetching…" : "Refresh"}
                        </span>
                      </Button>
                    )}
                  </div>
                  {modelsCache && isStale && (
                    <p className="text-xs text-yellow-500">
                      Cache is over 5 days old — refresh to update model list
                    </p>
                  )}
                  {!selectedAgent && (
                    <p className="text-xs text-muted-foreground">
                      Select an agent to enable model selection
                    </p>
                  )}
                  {refreshMutation.isError && (
                    <p className="text-xs text-destructive">
                      {refreshMutation.error instanceof Error
                        ? refreshMutation.error.message
                        : "Failed to fetch models"}
                    </p>
                  )}
                </div>
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
