import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { invoke } from "../lib/tauri-mock";
import * as Dialog from "@radix-ui/react-dialog";
import {
  useConfigStore,
  AVAILABLE_MCP_SERVERS,
  AVAILABLE_SKILLS,
  AVAILABLE_MODELS,
} from "../store/configStore";
import type { ProjectConfigResponse, ProjectConfigRequest } from "../types/bindings";
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

  const selectedModelDefault = watch("model_default");

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content project-settings-modal">
          <Dialog.Title className="dialog-title">
            Project Configuration
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            Configure project-level defaults for Claude model, MCP servers, and
            skills that apply to all tasks unless overridden.
          </Dialog.Description>

          {error && <div className="error-banner">{error}</div>}

          {isLoading ? (
            <div className="loading-spinner">Loading settings...</div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="settings-form">
              {/* Model Selection */}
              <fieldset className="form-fieldset">
                <legend>Claude Model</legend>
                <select
                  {...register("model_default", { required: true })}
                  className="form-select"
                >
                  {AVAILABLE_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </fieldset>

              {/* MCP Servers */}
              <fieldset className="form-fieldset">
                <legend>MCP Servers</legend>
                <div className="checkbox-group">
                  {AVAILABLE_MCP_SERVERS.map((server) => (
                    <label key={server} className="checkbox-label">
                      <input
                        type="checkbox"
                        {...register(`mcp_servers.${server}`)}
                        className="form-checkbox"
                      />
                      <span>{server}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* Skills */}
              <fieldset className="form-fieldset">
                <legend>Skills</legend>
                <div className="checkbox-group">
                  {AVAILABLE_SKILLS.map((skill) => (
                    <label key={skill} className="checkbox-label">
                      <input
                        type="checkbox"
                        {...register(`skills.${skill}`)}
                        className="form-checkbox"
                      />
                      <span>{skill}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* Buttons */}
              <div className="form-buttons">
                <button
                  type="submit"
                  disabled={isSaving || !selectedModelDefault}
                  className="btn-primary"
                >
                  {isSaving ? "Saving..." : "Save Configuration"}
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isSaving}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              ✕
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
