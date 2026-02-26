import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TaskForm } from "@/components/task/TaskForm";
import { Task, CreateTaskRequest } from "@/types/bindings";

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  onTaskCreated: (task: Task) => void;
}

export function TaskModal({ isOpen, onClose, projectId, onTaskCreated }: TaskModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (data: CreateTaskRequest) => {
    setIsLoading(true);
    setError(null);

    try {
      const newTask = await invoke<Task>("create_task", {
        projectId: projectId,
        name: data.name,
        description: data.description,
        acceptanceCriteria: data.acceptance_criteria,
        skills: data.skills,
      });

      onTaskCreated(newTask);
      onClose();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create task";
      setError(errorMessage);
      console.error("Task creation error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent>
          <DialogTitle>Create New Task</DialogTitle>
          <DialogDescription>
            Enter task details (title, description, acceptance criteria required)
          </DialogDescription>

          {error && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          <TaskForm
            onSubmit={handleSubmit}
            isLoading={isLoading}
            onCancel={onClose}
            projectId={projectId}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
