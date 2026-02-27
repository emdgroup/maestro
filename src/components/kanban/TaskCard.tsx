import React, { useState, useEffect } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "@/types/bindings";
import { useBoardStore } from "@/store/boardStore";
import { useExecutionLogsQuery } from "@/services/task.service";
import { toast } from "sonner";
import { TaskContextMenu } from "@/components/task/TaskContextMenu";

/// Get status dot color based on task status
function getStatusDotColor(status: string): string {
  switch (status) {
    case "Done":
      return "bg-success";
    case "InProgress":
      return "bg-warning";
    case "Review":
    case "Merging":
      return "bg-secondary";
    case "Ready":
      return "bg-accent";
    case "Backlog":
    case "Failed":
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
  isDragging?: boolean;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
  onReviewClick?: (taskId: number, taskName: string) => void;
  onSettingsClick?: (task: Task) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  isDragging = false,
  projectPath = "",
  onTaskClick,
  onReviewClick,
  onSettingsClick,
}) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isPauseLoading, setIsPauseLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [elapsedTime, setElapsedTime] = useState("0s");
  const store = useBoardStore();

  // Load latest execution logs using TanStack Query
  const { data: logs = [] } = useExecutionLogsQuery(
    task.status === "InProgress" ? task.id : null
  );

  const executionLog = logs.length > 0 ? logs[0] : null;

  // Update elapsed time every 1 second for running tasks
  useEffect(() => {
    if (task.status !== "InProgress" || !executionLog?.started_at) {
      return;
    }

    const interval = setInterval(() => {
      setElapsedTime(formatElapsedTime(executionLog.started_at));
    }, 1000);

    return () => clearInterval(interval);
  }, [task.status, executionLog?.started_at]);

  // Don't make imported tasks draggable - they are read-only
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging: isActivelyDragging,
  } = useDraggable({
    id: task.id,
    disabled: task.is_imported,
  });

  // If this is the overlay card, don't apply transform
  // If this is being actively dragged, hide it (the overlay will show)
  const style = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    opacity: isActivelyDragging ? 0 : 1,
    cursor: task.is_imported ? "default" : "grab",
  };

  const handleExecute = async () => {
    setIsExecuting(true);
    try {
      const executionLogId = await store.executeTask(task.project_id, task.id, projectPath);
      console.log("Execution started:", executionLogId);
      toast.success(`Execution started for "${task.name}"`);
    } catch (error) {
      console.error("Execution failed:", error);
      toast.error(
        `Failed to start execution: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      case "Merging":
        return "⚙️ Merging";
      case "Done":
        return "✅ Done";
      case "Failed":
        return "❌ Failed";
      case "Backlog":
        return "📋 Backlog";
      case "Ready":
        return "🚀 Ready";
      default:
        return status;
    }
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      toast.success(`Retrying: ${task.name}`);
      await store.resumeExecution(task.project_id, task.id, projectPath);
    } catch (error) {
      toast.error(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleAbort = async () => {
    setIsAborting(true);
    try {
      toast.success(`Task aborted: ${task.name}`);
      await store.abortExecution(task.project_id, task.id);
    } catch (error) {
      toast.error(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAborting(false);
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

  return (
    <div
      ref={!isDragging ? setNodeRef : undefined}
      style={style}
      {...(!isDragging && !task.is_imported ? listeners : {})}
      {...(!isDragging && !task.is_imported ? attributes : {})}
      className={`rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 ${
        !task.is_imported ? "cursor-grab hover:shadow-md hover:border-ring" : "cursor-default"
      } ${task.status === "Failed" ? "bg-error/10 border-error/30" : ""}`}
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
            className={`h-2 w-2 rounded-full flex-shrink-0 ${getStatusDotColor(task.status)} ${task.status === "InProgress" ? "animate-pulse" : ""}`}
          />
          <div className="font-base text-foreground truncate">{task.name}</div>
        </div>
        <div className="relative flex-shrink-0">
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
        {task.status === "Merging" && (
          <div className="mt-1 text-xs italic text-muted-foreground animate-pulse">
            Merge in progress...
          </div>
        )}
        {task.is_imported && (
          <span className="inline-block px-2 py-1 text-xs font-medium rounded bg-success/10 text-success">
            🔒 Read-only
          </span>
        )}
      </div>

      {task.status === "Failed" && (
        <div className="mt-2 p-2 bg-error/10 border border-error/30 rounded text-xs text-error max-h-16 overflow-hidden">
          <div className="font-semibold mb-1">Error Details:</div>
          <div className="text-error/80">Click task to view full error details and suggestions</div>
        </div>
      )}
      {task.status === "Ready" && (
        <button
          onClick={handleExecute}
          disabled={isExecuting}
          className={`mt-2 w-full px-3 py-2 text-sm font-semibold rounded transition-all duration-200 ${
            isExecuting
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-accent text-accent-foreground hover:shadow-md"
          }`}
        >
          {isExecuting ? "Executing..." : "Execute"}
        </button>
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
      {task.status === "Failed" && (
        <div className="mt-2 flex gap-2 flex-wrap">
          <button
            onClick={handleRetry}
            disabled={isRetrying || isAborting}
            className={`flex-1 min-w-14 px-2 py-1 text-xs font-semibold rounded transition-all duration-200 ${
              isRetrying || isAborting
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-success text-success-foreground hover:shadow-md"
            }`}
            title="Retry execution with same command"
          >
            {isRetrying ? "⏳" : "🔄 Resume"}
          </button>
          <button
            onClick={handleAbort}
            disabled={isAborting || isRetrying}
            className={`flex-1 min-w-14 px-2 py-1 text-xs font-semibold rounded transition-all duration-200 ${
              isAborting || isRetrying
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-error text-error-foreground hover:shadow-md"
            }`}
            title="Mark task as failed and stop recovery"
          >
            {isAborting ? "⏳" : "⏹️ Abort"}
          </button>
          <button
            onClick={() => onTaskClick?.(task)}
            disabled={isRetrying || isAborting}
            className={`flex-1 min-w-20 px-2 py-1 text-xs font-semibold rounded transition-all duration-200 ${
              isRetrying || isAborting
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-accent text-accent-foreground hover:shadow-md"
            }`}
            title="Attach terminal to debug"
          >
            🔌 Terminal
          </button>
        </div>
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
