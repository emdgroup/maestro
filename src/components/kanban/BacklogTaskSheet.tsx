import { useState } from "react";
import { X } from "lucide-react";
import { TaskForm } from "@/components/task/TaskForm";
import type { Task } from "@/types/bindings";
import { useCreateTaskMutation, useUpdateTask } from "@/services/task.service";
import type { TaskFormData } from "@/components/task/TaskForm";

interface BacklogTaskSheetProps {
  onClose: () => void;
  mode: "create" | "edit";
  task?: Task | null;
  projectId: number;
  onSuccess?: () => void;
}

function taskToFormValues(task: Task): Partial<TaskFormData> {
  return {
    title: task.name,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria ?? "",
    priority: task.priority,
    baseBranch: task.base_branch ?? "",
  };
}

export function BacklogTaskSheet({
  onClose,
  mode,
  task,
  projectId,
  onSuccess,
}: BacklogTaskSheetProps) {
  const [error, setError] = useState<string | null>(null);
  const { mutate: createTask, isPending: isCreating } = useCreateTaskMutation();
  const { mutate: updateTask, isPending: isUpdating } = useUpdateTask();

  const isLoading = isCreating || isUpdating;

  const handleSubmit = async (data: Task) => {
    setError(null);

    if (mode === "create") {
      createTask(
        { ...data },
        {
          onSuccess: () => {
            onClose();
            onSuccess?.();
          },
          onError: (err) => {
            setError(err instanceof Error ? err.message : "Failed to create task");
          },
        },
      );
    } else if (mode === "edit" && task) {
      updateTask(
        {
          taskId: task.id,
          updates: {
            name: data.name,
            description: data.description,
            acceptance_criteria: data.acceptance_criteria,
            priority: data.priority,
            base_branch: data.base_branch,
          },
        },
        {
          onSuccess: () => {
            onClose();
            onSuccess?.();
          },
          onError: (err) => {
            setError(err instanceof Error ? err.message : "Failed to update task");
          },
        },
      );
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {mode === "create" ? "New Task" : "Edit Task"}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {mode === "create" ? "Fill in the details to create a new task" : "Update task details"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          aria-label="Close panel"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 text-sm mx-4 mt-4 rounded">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4">
        <TaskForm
          onSubmit={handleSubmit}
          isLoading={isLoading}
          onCancel={onClose}
          projectId={projectId}
          initialValues={mode === "edit" && task ? taskToFormValues(task) : undefined}
          submitLabel={mode === "create" ? "Create Task" : "Save Changes"}
        />
      </div>
    </div>
  );
}
