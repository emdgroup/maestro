import React, { useState } from "react";
import { Task } from "@/types/bindings";
import { useUpdateTask } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import { toast } from "sonner";
import { TaskContextMenu } from "@/components/task/TaskContextMenu";
import { useExecuteTask } from "@/hooks/useExecuteTask";

/// Get status dot color based on task status
function getStatusDotColor(status: string): string {
  switch (status) {
    case "Done":
      return "bg-success";
    case "InProgress":
      return "bg-warning";
    case "Review":
      return "bg-secondary";
    case "Ready":
      return "bg-accent";
    case "Backlog":
    default:
      return "bg-muted";
  }
}


interface TaskCardProps {
  task: Task;
  onReviewClick?: (taskId: number, taskName: string) => void;
  onSettingsClick?: (task: Task) => void;
  onArchiveClick?: (taskId: number) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onReviewClick,
  onSettingsClick,
  onArchiveClick,
}) => {
  // Get context from KanbanProvider
  const { projectId, projectPath, onTaskClick } = useKanban();

  const [menuOpen, setMenuOpen] = useState(false);
  const updateTask = useUpdateTask();
  const { execute: handleExecute, isExecuting } = useExecuteTask(projectId, projectPath);

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "InProgress":
        return "🔄 Running";
      case "Review":
        return "👀 Review";
      case "Done":
        return "✅ Done";
      case "Backlog":
        return "📋 Backlog";
      case "Ready":
        return "🚀 Ready";
      case "Cancelled":
        return "🚫 Cancelled";
      default:
        return status;
    }
  };

  const handleBackToBacklog = () => {
    updateTask.mutate(
      { taskId: task.id, updates: { status: "Backlog" } },
      {
        onSuccess: () => {
          toast.success(`"${task.name}" moved back to Backlog`);
        },
      },
    );
  };

  return (
    <div
      className="rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 cursor-default hover:shadow-md hover:border-ring"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <div className="flex justify-between items-start gap-2">
        <div
          className="flex items-center gap-2 flex-1 cursor-pointer"
          onClick={() => onTaskClick?.(task)}
        >
          <div
            className={`h-2 w-2 rounded-full shrink-0 ${getStatusDotColor(task.status)} ${task.status === "InProgress" ? "animate-pulse" : ""}`}
          />
          <div className="font-base text-foreground truncate">{task.name}</div>
        </div>
        <div className="relative shrink-0">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            title="Task menu"
          >
            ⋮
          </button>
          <TaskContextMenu
            task={task}
            isOpen={menuOpen}
            onClose={() => setMenuOpen(false)}
            onEditSettings={() => onSettingsClick?.(task)}
          />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {task.status !== "Backlog" && task.status !== "Ready" && (
          <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-muted text-muted-foreground">
            {getStatusLabel(task.status)}
          </span>
        )}
        {task.is_imported && (
          <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-success/10 text-success">
            🔒 Read-only
          </span>
        )}
      </div>

      {task.status === "Ready" && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => handleExecute(task)}
            disabled={isExecuting}
            className={`flex-1 px-3 py-2 text-sm font-semibold rounded transition-all duration-200 ${
              isExecuting
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-accent text-accent-foreground hover:shadow-md"
            }`}
          >
            {isExecuting ? "Executing..." : "Execute"}
          </button>
          <button
            onClick={handleBackToBacklog}
            disabled={isExecuting}
            className="px-3 py-2 text-sm font-semibold rounded transition-all duration-200 bg-muted text-muted-foreground hover:bg-muted/80 hover:shadow-md"
            title="Move back to Backlog"
          >
            Back
          </button>
        </div>
      )}
      {task.status === "Review" && (
        <button
          onClick={() => onReviewClick?.(task.id, task.name)}
          className="mt-2 w-full px-3 py-2 text-sm font-semibold rounded bg-secondary text-secondary-foreground hover:shadow-md transition-all duration-200"
          title="View diff and approve/reject changes"
        >
          Review
        </button>
      )}
      {task.status === "Done" && !task.archived_at && (
        <button
          onClick={() => onArchiveClick?.(task.id)}
          className="mt-2 w-full px-3 py-2 text-sm font-semibold rounded bg-muted text-muted-foreground hover:bg-muted/80 hover:shadow-md transition-all duration-200"
          title="Archive this task"
        >
          Archive
        </button>
      )}
    </div>
  );
};
