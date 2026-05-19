import { useEffect, forwardRef, useImperativeHandle } from "react";
import { useForm, Controller } from "react-hook-form";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Button } from "@/ui/button";
import { Bot } from "lucide-react";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import {
  useAgentDiscoveryQuery,
  useAgentCacheQuery,
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


export const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(
  ({ projectId, connectionId }, ref) => {
    const { control, handleSubmit, watch, setValue, reset } = useForm<ProjectSettingsFormData>({
      defaultValues: { default_agent: "", default_model: "" },
    });

    const selectedAgent = watch("default_agent");

    const projectSettingsQuery = useProjectSettings(projectId);
    const updateProjectSettingsMutation = useUpdateProjectSettings();
    const { data: discovery, isLoading: agentsLoading } = useAgentDiscoveryQuery(connectionId);
    const { data: agentCache, isLoading: cacheLoading } = useAgentCacheQuery(
      projectId,
      selectedAgent || null,
    );

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
                                {agent.icon && (
                                  <img
                                    src={agent.icon}
                                    className="w-4 h-4 rounded-sm shrink-0 dark:[filter:invert(1)]"
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
                                      ? "No models cached yet"
                                      : "Select a model"
                              }
                            >
                              {field.value === ""
                                ? "Agent default"
                                : (availableModels.find((m) => m.value === field.value)?.name ?? field.value)}
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
