import { useState } from "react";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/ui/dialog";
import { TaskForm } from "@/components/task/TaskForm";
import { Task, CreateTaskRequest } from "@/types/bindings";
import { useCreateTaskMutation } from "@/services/task.service";

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  onTaskCreated: (task: Task) => void;
}

export function TaskModal({ isOpen, onClose, projectId, onTaskCreated }: TaskModalProps) {
  const [error, setError] = useState<string | null>(null);
  const { mutate: createTask, isPending: isLoading } = useCreateTaskMutation();

  const handleSubmit = async (data: CreateTaskRequest) => {
    setError(null);

    createTask(
      {
        ...data,
      },
      {
        onSuccess: (newTask) => {
          onTaskCreated(newTask);
          onClose();
        },
        onError: (err) => {
          const errorMessage = err instanceof Error ? err.message : "Failed to create task";
          setError(errorMessage);
          console.error("Task creation error:", err);
        },
      }
    );
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
