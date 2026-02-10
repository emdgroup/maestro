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
import "../styles/ProjectSettingsModal.css";

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
          { project_id: projectId }
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
        <DialogContent className="project-settings-modal">
          <DialogTitle>
            Project Configuration
          </DialogTitle>
          <DialogDescription>
            Configure project-level defaults for Claude model, MCP servers, and
            skills that apply to all tasks unless overridden.
          </DialogDescription>

          {error && <div className="error-banner">{error}</div>}

          {isLoading ? (
            <div className="loading-spinner">Loading settings...</div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="settings-form">
              {/* Model Selection */}
              <div className="form-fieldset">
                <Label htmlFor="model_default">Claude Model</Label>
                <select
                  id="model_default"
                  {...register("model_default", { required: true })}
                  className="w-full px-3 py-2 border rounded-md bg-background text-foreground"
                >
                  {AVAILABLE_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>

              {/* MCP Servers */}
              <div className="form-fieldset">
                <Label>MCP Servers</Label>
                <div className="checkbox-group space-y-2">
                  {AVAILABLE_MCP_SERVERS.map((server) => (
                    <div key={server} className="flex items-center space-x-2">
                      <Checkbox
                        id={`mcp-${server}`}
                        {...register(`mcp_servers.${server}`)}
                      />
                      <Label htmlFor={`mcp-${server}`} className="cursor-pointer">{server}</Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Skills */}
              <div className="form-fieldset">
                <Label>Skills</Label>
                <div className="checkbox-group space-y-2">
                  {AVAILABLE_SKILLS.map((skill) => (
                    <div key={skill} className="flex items-center space-x-2">
                      <Checkbox
                        id={`skill-${skill}`}
                        {...register(`skills.${skill}`)}
                      />
                      <Label htmlFor={`skill-${skill}`} className="cursor-pointer">{skill}</Label>
                    </div>
                  ))}
                </div>
              </div>

              {/* Appearance - Theme */}
              <div className="form-fieldset">
                <Label htmlFor="theme_preference">Appearance - Theme</Label>
                <select
                  id="theme_preference"
                  defaultValue="system"
                  onChange={handleThemeChange}
                  className="w-full px-3 py-2 border rounded-md bg-background text-foreground"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </div>

              {/* Buttons */}
              <div className="form-buttons">
                <Button
                  type="submit"
                  disabled={isSaving || !selectedModelDefault}
                >
                  {isSaving ? "Saving..." : "Save Configuration"}
                </Button>
                <Button
                  type="button"
                  onClick={handleClose}
                  disabled={isSaving}
                  variant="outline"
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          <DialogClose asChild>
            <Button variant="ghost" size="sm" aria-label="Close">
              ✕
            </Button>
          </DialogClose>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
