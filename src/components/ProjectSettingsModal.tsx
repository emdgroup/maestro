import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { invoke } from "../lib/tauri-mock";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useConfigStore,
  AVAILABLE_MCP_SERVERS,
  AVAILABLE_SKILLS,
  AVAILABLE_MODELS,
} from "../store/configStore";
import type { ProjectConfigResponse, ProjectConfigRequest, AppSettings } from "../types/bindings";
import { useTheme } from "../providers/ThemeProvider";

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
}

interface ProjectSettingsFormData {
  model_default: string;
  mcp_servers: Record<string, boolean>;
  skills: Record<string, boolean>;
  theme_preference: string;
}

export function ProjectSettingsModal({
  isOpen,
  onClose,
  projectId,
}: ProjectSettingsModalProps) {
  const {
    model_default,
    mcp_allowlist,
    skills_default,
    isLoading,
    error,
    setState,
    setLoading,
    setError,
    clearError,
    resetConfig,
  } = useConfigStore();

  const [isSaving, setIsSaving] = useState(false);
  const { setTheme } = useTheme();
  const {
    register,
    handleSubmit,
    watch,
    reset,
  } = useForm<ProjectSettingsFormData>({
    mode: "onChange",
    defaultValues: {
      model_default: model_default || AVAILABLE_MODELS[0],
      mcp_servers: AVAILABLE_MCP_SERVERS.reduce(
        (acc, server) => {
          acc[server] = mcp_allowlist?.includes(server) ?? false;
          return acc;
        },
        {} as Record<string, boolean>
      ),
      skills: AVAILABLE_SKILLS.reduce(
        (acc, skill) => {
          acc[skill] = skills_default?.includes(skill) ?? false;
          return acc;
        },
        {} as Record<string, boolean>
      ),
      theme_preference: "system",
    },
  });

  // Fetch settings when modal opens
  useEffect(() => {
    if (!isOpen) return;

    async function fetchSettings() {
      setLoading(true);
      clearError();

      try {
        const response = await invoke<ProjectConfigResponse>(
          "get_project_settings",
          { projectId: projectId }
        );

        // Also fetch global theme preference
        const appSettings = await invoke<AppSettings>("get_settings", {});

        // Convert arrays to checkbox records
        const mcp_servers_record = AVAILABLE_MCP_SERVERS.reduce(
          (acc, server) => {
            acc[server] = response.mcp_allowlist?.includes(server) ?? false;
            return acc;
          },
          {} as Record<string, boolean>
        );

        const skills_record = AVAILABLE_SKILLS.reduce(
          (acc, skill) => {
            acc[skill] = response.skills_default?.includes(skill) ?? false;
            return acc;
          },
          {} as Record<string, boolean>
        );

        setState({
          model_default: response.model_default,
          mcp_allowlist: response.mcp_allowlist || [],
          skills_default: response.skills_default || [],
        });

        reset({
          model_default: response.model_default,
          mcp_servers: mcp_servers_record,
          skills: skills_record,
          theme_preference: (appSettings?.theme_preference || "system") as string,
        });

        setLoading(false);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load settings";
        setError(errorMessage);
        setLoading(false);
        console.error("Failed to fetch project settings:", err);
      }
    }

    fetchSettings();
  }, [isOpen, projectId, setLoading, clearError, setState, reset, setError]);

  const onSubmit = async (data: ProjectSettingsFormData) => {
    if (!data.model_default) {
      setError("Model selection is required");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      // Convert checkbox records back to arrays
      const mcp_allowlist = Object.entries(data.mcp_servers)
        .filter(([_, enabled]) => enabled)
        .map(([server]) => server);

      const skills_default = Object.entries(data.skills)
        .filter(([_, enabled]) => enabled)
        .map(([skill]) => skill);

      const request: ProjectConfigRequest = {
        model_default: data.model_default,
        mcp_allowlist,
        skills_default,
      };

      await invoke("update_project_settings", {
        project_id: projectId,
        settings: request,
      });

      setState({
        model_default: data.model_default,
        mcp_allowlist,
        skills_default,
      });

      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to save settings";
      setError(errorMessage);
      console.error("Failed to save project settings:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    resetConfig();
    onClose();
  };

  const handleThemeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newTheme = e.target.value as 'light' | 'dark' | 'system';
    try {
      await setTheme(newTheme);
    } catch (err) {
      console.error('Failed to change theme:', err);
      // Don't show toast, silently log error per phase decision
    }
  };

  const selectedModelDefault = watch("model_default");

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <DialogTitle className="text-xl font-semibold">
                Project Settings
              </DialogTitle>
              <DialogDescription className="mt-1">
                Configure model defaults, MCP servers, skills, and appearance for this project
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                ✕
              </Button>
            </DialogClose>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-error/10 border border-error rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading settings...
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              {/* Model Defaults Section */}
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span>🤖</span> Model Defaults
                </h3>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="model_default" className="text-sm font-medium mb-2 block">
                      Claude Model
                    </Label>
                    <select
                      id="model_default"
                      {...register("model_default", { required: true })}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground
                                 focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {AVAILABLE_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Default Claude model for new tasks in this project
                    </p>
                  </div>
                </div>
              </div>

              {/* MCP Servers Section */}
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span>⚙️</span> MCP Servers
                </h3>
                <div className="space-y-3 bg-muted/20 p-3 rounded-lg">
                  {AVAILABLE_MCP_SERVERS.map((server) => (
                    <div key={server} className="flex items-center gap-3">
                      <Checkbox
                        id={`mcp-${server}`}
                        {...register(`mcp_servers.${server}`)}
                      />
                      <Label
                        htmlFor={`mcp-${server}`}
                        className="text-sm font-medium cursor-pointer flex-1 m-0"
                      >
                        {server}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Skills Section */}
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span>✨</span> Skills
                </h3>
                <div className="space-y-3 bg-muted/20 p-3 rounded-lg">
                  {AVAILABLE_SKILLS.map((skill) => (
                    <div key={skill} className="flex items-center gap-3">
                      <Checkbox
                        id={`skill-${skill}`}
                        {...register(`skills.${skill}`)}
                      />
                      <Label
                        htmlFor={`skill-${skill}`}
                        className="text-sm font-medium cursor-pointer flex-1 m-0"
                      >
                        {skill}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Appearance Section */}
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span>🎨</span> Appearance
                </h3>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="theme_preference" className="text-sm font-medium mb-2 block">
                      Theme
                    </Label>
                    <select
                      id="theme_preference"
                      defaultValue="system"
                      onChange={handleThemeChange}
                      className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground
                                 focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                      <option value="system">System</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Choose how the interface appears
                    </p>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <Button
                  type="button"
                  onClick={handleClose}
                  disabled={isSaving}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSaving || !selectedModelDefault}
                  className="bg-accent hover:bg-accent/90"
                >
                  {isSaving ? "Saving..." : "Save Settings"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
