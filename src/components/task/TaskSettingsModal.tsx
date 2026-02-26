import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { taskService } from "@/services";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Checkbox } from "@/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { AVAILABLE_MCP_SERVERS, AVAILABLE_SKILLS, AVAILABLE_MODELS } from "@/store/configStore";
import type { Task, TaskConfigRequest } from "@/types/bindings";
import { X } from "lucide-react";

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
  availableItems: string[],
): Record<string, boolean> {
  return availableItems.reduce(
    (acc, item) => {
      acc[item] = items?.includes(item) ?? false;
      return acc;
    },
    {} as Record<string, boolean>,
  );
}

export function TaskSettingsModal({ isOpen, onClose, task }: TaskSettingsModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const { register, handleSubmit, reset, watch } = useForm<TaskSettingsFormData>({
    mode: "onChange",
    defaultValues: {
      model_override: task.model_override || "",
      mcp_allowlist: arrayToCheckboxRecord(task.mcp_allowlist, AVAILABLE_MCP_SERVERS),
      skills_override: arrayToCheckboxRecord(task.skills_override, AVAILABLE_SKILLS),
    },
  });

  // Update form when task changes
  useEffect(() => {
    if (!isOpen) return;

    reset({
      model_override: task.model_override || "",
      mcp_allowlist: arrayToCheckboxRecord(task.mcp_allowlist, AVAILABLE_MCP_SERVERS),
      skills_override: arrayToCheckboxRecord(task.skills_override, AVAILABLE_SKILLS),
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

      await taskService.updateTaskSettings(
        task.project_id,
        task.id,
        request as any
      );

      onClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to save settings";
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
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="max-w-2xl">
          <DialogTitle>Task Configuration Overrides</DialogTitle>
          <DialogDescription>
            <p>Configure task-specific overrides for Claude model, MCP servers, and skills.</p>
            <p className="text-xs text-muted-foreground mb-4">
              Leave unchecked to use project defaults. Any settings you enable here will completely
              replace the project defaults for this task only.
            </p>
          </DialogDescription>

          {error && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            {/* Model Override */}
            <fieldset className="border border-border rounded-md p-4 space-y-3">
              <legend>Claude Model Override</legend>
              <div className="text-sm text-muted-foreground mb-3">
                Leave empty to use project default
              </div>
              <Select
                value={watch("model_override")}
                onValueChange={(value) => {
                  // Register field and set value
                  const event = { target: { value, name: "model_override" } };
                  register("model_override").onChange?.(event);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Use Project Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Use Project Default</SelectItem>
                  {AVAILABLE_MODELS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </fieldset>

            {/* MCP Servers Override */}
            <fieldset className="border border-border rounded-md p-4 space-y-3">
              <legend>MCP Servers Override</legend>
              <div className="text-sm text-muted-foreground mb-3">
                Leave unchecked to use project defaults
              </div>
              <div className="space-y-2">
                {AVAILABLE_MCP_SERVERS.map((server) => (
                  <div key={server} className="flex items-center space-x-2">
                    <Checkbox
                      id={`mcp-override-${server}`}
                      {...register(`mcp_allowlist.${server}`)}
                    />
                    <Label htmlFor={`mcp-override-${server}`} className="cursor-pointer">
                      {server}
                    </Label>
                  </div>
                ))}
              </div>
            </fieldset>

            {/* Skills Override */}
            <fieldset className="border border-border rounded-md p-4 space-y-3">
              <legend>Skills Override</legend>
              <div className="text-sm text-muted-foreground mb-3">
                Leave unchecked to use project defaults
              </div>
              <div className="space-y-2">
                {AVAILABLE_SKILLS.map((skill) => (
                  <div key={skill} className="flex items-center space-x-2">
                    <Checkbox
                      id={`skill-override-${skill}`}
                      {...register(`skills_override.${skill}`)}
                    />
                    <Label htmlFor={`skill-override-${skill}`} className="cursor-pointer">
                      {skill}
                    </Label>
                  </div>
                ))}
              </div>
            </fieldset>

            {/* Buttons */}
            <div className="flex justify-end gap-3 pt-4">
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Saving..." : "Save Overrides"}
              </Button>
              <Button type="button" onClick={handleClose} disabled={isSaving} variant="outline">
                Cancel
              </Button>
            </div>
          </form>

          <DialogClose
            render={
              <Button variant="ghost" size="sm" aria-label="Close">
                <X className="size-3.5" />
              </Button>
            }
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
