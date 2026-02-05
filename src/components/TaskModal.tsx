import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";
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
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">Create New Task</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Enter task details (title, description, acceptance criteria required)
          </Dialog.Description>

          {error && <div className="error-banner">{error}</div>}

          <TaskForm
            onSubmit={handleSubmit}
            isLoading={isLoading}
            onCancel={onClose}
            projectId={projectId}
          />

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
