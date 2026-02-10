import { useState } from "react";
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
import { TaskForm } from "./TaskForm";
import { Task, CreateTaskRequest } from "../types/bindings";
import "../styles/TaskModal.css";

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  onTaskCreated: (task: Task) => void;
}

export function TaskModal({
  isOpen,
  onClose,
  projectId,
  onTaskCreated,
}: TaskModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (data: CreateTaskRequest) => {
    setIsLoading(true);
    setError(null);

    try {
      const newTask = await invoke<Task>("create_task", {
        name: data.name,
        description: data.description,
        acceptance_criteria: data.acceptance_criteria,
        project_id: data.project_id,
        skills: data.skills,
      });

      onTaskCreated(newTask);
      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create task";
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

          {error && <div className="error-banner">{error}</div>}

          <TaskForm
            onSubmit={handleSubmit}
            isLoading={isLoading}
            onCancel={onClose}
            projectId={projectId}
          />

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
