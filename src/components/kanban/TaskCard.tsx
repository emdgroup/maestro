import React, { useState, useMemo } from "react";
import { Task } from "@/types/bindings";
import { useBoardStore } from "@/store/boardStore";
import { useExecutionLogsQuery, useUpdateTask } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import { toast } from "sonner";
import { TaskContextMenu } from "@/components/task/TaskContextMenu";
import { api } from "@/lib";
import { useNavigate } from "@/store/navigationStore";

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

/// Format elapsed time from a start timestamp to human-readable string
/// Returns format: "Xm Ys", "Xs", or "Xh Ym"
function formatElapsedTime(startedAt?: string): string {
  if (!startedAt) return "0s";

  try {
    const startTime = new Date(startedAt).getTime();
    const now = Date.now();
    const diffMs = now - startTime;

    if (diffMs < 0) return "0s";
    if (diffMs < 1000) return `${Math.floor(diffMs / 100) * 100}ms`;

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  } catch {
    return "0s";
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

  const [isExecuting, setIsExecuting] = useState(false);
  const [isPauseLoading, setIsPauseLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const store = useBoardStore();
  const updateTask = useUpdateTask();
  const navigate = useNavigate();

  // Load latest execution logs using TanStack Query
  const { data: logs = [] } = useExecutionLogsQuery(task.status === "InProgress" ? task.id : null);

  const executionLog = logs.length > 0 ? logs[0] : null;

  // Calculate elapsed time as a computed value (no polling)
  const elapsedTime = useMemo(() => {
    if (task.status === "InProgress" && executionLog?.started_at) {
      return formatElapsedTime(executionLog.started_at);
    }
    return "0s";
  }, [task.status, executionLog?.started_at]);

  const handleExecute = async () => {
    setIsExecuting(true);
    try {
      // Find the worktree branch for this task
      const worktrees = await api.listWorktreesWithStatus(projectId, projectPath);
      const worktree = worktrees.find((w) => w.task_id === task.id);
      const branchName = worktree?.branch_name ?? task.origin_branch;
      if (!branchName) {
        toast.error(`No worktree or branch found for "${task.name}". Create a worktree first.`);
        return;
      }
      const logId = await api.spawnInteractiveExecution(projectId, branchName, projectPath, task.name);
      navigate({ agentId: String(logId) });
      toast.success(`Session started for "${task.name}"`);
    } catch (error) {
      toast.error(`Execution failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExecuting(false);
    }
  };

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

  const handlePause = async () => {
    setIsPauseLoading(true);
    try {
      await store.pauseExecution(task.id);
      toast.success(`Task paused: ${task.name}`);
    } catch (error) {
      toast.error(`Failed to pause: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPauseLoading(false);
    }
  };

  const handleResume = async () => {
    setIsPauseLoading(true);
    try {
      await store.resumeExecution(task.project_id, task.id, projectPath);
      toast.success(`Task resumed: ${task.name}`);
    } catch (error) {
      toast.error(`Failed to resume: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPauseLoading(false);
    }
  };

  const handleBackToBacklog = () => {
    updateTask.mutate(
      { taskId: task.id, updates: { status: "Backlog" } },
      {
        onSuccess: () => {
          store.updateTaskStatus(task.id, "Backlog");
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
      {/* Status badge with elapsed time */}
      {task.status === "InProgress" && executionLog && (
        <div
          className={`mt-2 inline-block px-2 py-1 text-xs font-medium rounded ${
            executionLog.status === "running"
              ? "bg-warning/20 text-warning animate-pulse"
              : executionLog.status === "failed"
                ? "bg-error/20 text-error"
                : executionLog.status === "complete"
                  ? "bg-success/20 text-success"
                  : "bg-muted text-muted-foreground"
          }`}
        >
          {executionLog.status === "running" && (
            <>
              <span>⟳ </span>
              <span>{elapsedTime}</span>
            </>
          )}
          {executionLog.status === "failed" && <span>Failed</span>}
          {executionLog.status === "complete" && <span>✓ Done</span>}
        </div>
      )}

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
            onClick={handleExecute}
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
      {task.status === "InProgress" && executionLog && (
        <div className="mt-2 flex gap-2 flex-wrap">
          {executionLog.status === "running" && (
            <button
              onClick={handlePause}
              disabled={isPauseLoading}
              className={`flex-1 min-w-20 px-2 py-1 text-xs font-semibold rounded transition-all duration-200 ${
                isPauseLoading
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-warning text-warning-foreground hover:shadow-md"
              }`}
              title="Pause execution without terminating process"
            >
              {isPauseLoading ? "⏳" : "⏸️ Pause"}
            </button>
          )}
          {executionLog.status === "paused" && (
            <button
              onClick={handleResume}
              disabled={isPauseLoading}
              className={`flex-1 min-w-20 px-2 py-1 text-xs font-semibold rounded transition-all duration-200 ${
                isPauseLoading
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-success text-success-foreground hover:shadow-md"
              }`}
              title="Resume paused execution"
            >
              {isPauseLoading ? "⏳" : "▶️ Resume"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
