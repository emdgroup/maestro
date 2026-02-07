import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { invoke } from "../lib/tauri-mock";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AVAILABLE_MCP_SERVERS,
  AVAILABLE_SKILLS,
  AVAILABLE_MODELS,
} from "../store/configStore";
import type { Task, TaskConfigRequest } from "../types/bindings";
import "../styles/TaskSettingsModal.css";

interface TaskSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  projectId?: number;
}

interface TaskSettingsFormData {
  model_override: string;
  mcp_allowlist: Record<string, boolean>;
  skills_override: Record<string, boolean>;
}

/**
 * Convert array (or null) to checkbox record
 * - null: all checkboxes unchecked (use project defaults)
 * - array: checkboxes checked for items in array
 */
function arrayToCheckboxRecord(
  items: string[] | undefined | null,
  availableItems: string[]
): Record<string, boolean> {
  return availableItems.reduce(
    (acc, item) => {
      acc[item] = items?.includes(item) ?? false;
      return acc;
    },
    {} as Record<string, boolean>
  );
}

export function TaskSettingsModal({
  isOpen,
  onClose,
  task,
}: TaskSettingsModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
  } = useForm<TaskSettingsFormData>({
    mode: "onChange",
    defaultValues: {
      model_override: task.model_override || "",
      mcp_allowlist: arrayToCheckboxRecord(
        task.mcp_allowlist,
        AVAILABLE_MCP_SERVERS
      ),
      skills_override: arrayToCheckboxRecord(
        task.skills_override,
        AVAILABLE_SKILLS
      ),
    },
  });

  // Update form when task changes
  useEffect(() => {
    if (!isOpen) return;

    reset({
      model_override: task.model_override || "",
      mcp_allowlist: arrayToCheckboxRecord(
        task.mcp_allowlist,
        AVAILABLE_MCP_SERVERS
      ),
      skills_override: arrayToCheckboxRecord(
        task.skills_override,
        AVAILABLE_SKILLS
      ),
    });

    setError(null);
  }, [isOpen, task, reset]);

  const onSubmit = async (data: TaskSettingsFormData) => {
    setIsSaving(true);
    setError(null);

    try {
      // Convert checkbox records back to arrays (or undefined if all unchecked)
      const mcp_allowlist = Object.entries(data.mcp_allowlist)
        .filter(([_, enabled]) => enabled)
        .map(([server]) => server);
      const mcp_allowlist_final = mcp_allowlist.length > 0 ? mcp_allowlist : undefined;

      const skills_override = Object.entries(data.skills_override)
        .filter(([_, enabled]) => enabled)
        .map(([skill]) => skill);
      const skills_override_final = skills_override.length > 0 ? skills_override : undefined;

      const model_override_final = data.model_override || undefined;

      const request: TaskConfigRequest = {
        model_override: model_override_final,
        mcp_allowlist: mcp_allowlist_final,
        skills_override: skills_override_final,
      };

      await invoke("update_task_settings", {
        task_id: task.id,
        ...request,
      });

      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to save settings";
      setError(errorMessage);
      console.error("Failed to save task settings:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setError(null);
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content task-settings-modal">
          <Dialog.Title className="dialog-title">
            Task Configuration Overrides
          </Dialog.Title>
          <Dialog.Description className="dialog-description">
            <p>
              Configure task-specific overrides for Claude model, MCP servers, and skills.
            </p>
            <p className="override-note">
              Leave unchecked to use project defaults. Any settings you enable here will completely replace the project defaults for this task only.
            </p>
          </Dialog.Description>

          {error && <div className="error-banner">{error}</div>}

          <form onSubmit={handleSubmit(onSubmit)} className="settings-form">
            {/* Model Override */}
            <fieldset className="form-fieldset">
              <legend>Claude Model Override</legend>
              <div className="fieldset-description">
                Leave empty to use project default
              </div>
              <select
                {...register("model_override")}
                className="form-select"
              >
                <option value="">Use Project Default</option>
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </fieldset>

            {/* MCP Servers Override */}
            <fieldset className="form-fieldset">
              <legend>MCP Servers Override</legend>
              <div className="fieldset-description">
                Leave unchecked to use project defaults
              </div>
              <div className="checkbox-group">
                {AVAILABLE_MCP_SERVERS.map((server) => (
                  <label key={server} className="checkbox-label">
                    <input
                      type="checkbox"
                      {...register(`mcp_allowlist.${server}`)}
                      className="form-checkbox"
                    />
                    <span>{server}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Skills Override */}
            <fieldset className="form-fieldset">
              <legend>Skills Override</legend>
              <div className="fieldset-description">
                Leave unchecked to use project defaults
              </div>
              <div className="checkbox-group">
                {AVAILABLE_SKILLS.map((skill) => (
                  <label key={skill} className="checkbox-label">
                    <input
                      type="checkbox"
                      {...register(`skills_override.${skill}`)}
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
                disabled={isSaving}
                className="btn-primary"
              >
                {isSaving ? "Saving..." : "Save Overrides"}
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
