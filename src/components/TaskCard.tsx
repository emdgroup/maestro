import React, { useState, useEffect } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { Task, ExecutionLog } from "../types/bindings";
import { useBoardStore } from "../store/boardStore";
import { showErrorToast, showSuccessToast } from "./ErrorToast";
import { TaskContextMenu } from "./TaskContextMenu";
import "../styles/TaskCard.css";

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

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false, projectPath = "", onTaskClick, onReviewClick, onSettingsClick }) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isPauseLoading, setIsPauseLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [elapsedTime, setElapsedTime] = useState("0s");
  const [executionLog, setExecutionLog] = useState<ExecutionLog | null>(null);
  const store = useBoardStore();

  // Load latest execution log for this task
  useEffect(() => {
    if (task.status !== "InProgress") {
      setExecutionLog(null);
      return;
    }

    const loadExecutionLog = async () => {
      try {
        const logs = await invoke<ExecutionLog[]>("get_execution_logs", { task_id: task.id });
        if (logs.length > 0) {
          setExecutionLog(logs[0]); // Get most recent log
        }
      } catch (error) {
        console.error("Failed to load execution log:", error);
      }
    };

    loadExecutionLog();
  }, [task.id, task.status]);

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
  const { attributes, listeners, setNodeRef, transform, isDragging: isActivelyDragging } = useDraggable({
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
      const executionLogId = await store.executeTask(
        task.project_id,
        task.id,
        projectPath
      );
      console.log('Execution started:', executionLogId);
      showSuccessToast(`Execution started for "${task.name}"`);
    } catch (error) {
      console.error('Execution failed:', error);
      showErrorToast(`Failed to start execution: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExecuting(false);
    }
  };

  // Status badge colors
  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'InProgress':
        return { backgroundColor: '#fef3c7', color: '#92400e' }; // Yellow
      case 'Review':
        return { backgroundColor: '#dbeafe', color: '#0369a1' }; // Blue
      case 'Merging':
        return { backgroundColor: '#e9d5ff', color: '#7e22ce' }; // Purple
      case 'Done':
        return { backgroundColor: '#dcfce7', color: '#166534' }; // Green
      case 'Failed':
        return { backgroundColor: '#fee2e2', color: '#991b1b' }; // Red
      default:
        return { backgroundColor: '#f3f4f6', color: '#374151' }; // Gray
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'InProgress':
        return '🔄 Running';
      case 'Review':
        return '👀 Review';
      case 'Merging':
        return '⚙️ Merging';
      case 'Done':
        return '✅ Done';
      case 'Failed':
        return '❌ Failed';
      case 'Backlog':
        return '📋 Backlog';
      case 'Ready':
        return '🚀 Ready';
      default:
        return status;
    }
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      showSuccessToast(`Retrying: ${task.name}`);
      await store.resumeExecution(task.project_id, task.id, projectPath);
    } catch (error) {
      showErrorToast(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleAbort = async () => {
    setIsAborting(true);
    try {
      showSuccessToast(`Task aborted: ${task.name}`);
      await store.abortExecution(task.project_id, task.id);
    } catch (error) {
      showErrorToast(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAborting(false);
    }
  };

  const handlePause = async () => {
    setIsPauseLoading(true);
    try {
      await store.pauseExecution(task.id);
      showSuccessToast(`Task paused: ${task.name}`);
    } catch (error) {
      showErrorToast(`Failed to pause: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPauseLoading(false);
    }
  };

  const handleResume = async () => {
    setIsPauseLoading(true);
    try {
      await store.resumeExecution(task.project_id, task.id, projectPath);
      showSuccessToast(`Task resumed: ${task.name}`);
    } catch (error) {
      showErrorToast(`Failed to resume: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsPauseLoading(false);
    }
  };

  return (
    <div
      ref={!isDragging ? setNodeRef : undefined}
      style={{
        ...style,
        ...(task.status === 'Failed' && {
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
        }),
      }}
      {...(!isDragging && !task.is_imported && task.status !== 'Failed' ? listeners : {})}
      {...(!isDragging && !task.is_imported && task.status !== 'Failed' ? attributes : {})}
      className={`task-card ${task.is_imported ? 'task-card-imported' : ''} ${task.status === 'Failed' ? 'task-card-failed' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      onMouseLeave={() => setMenuOpen(false)}
    >
      {/* Status badge with elapsed time */}
      {task.status === 'InProgress' && executionLog && (
        <div className={`badge-container ${
          executionLog.status === 'running' ? 'badge-running' :
          executionLog.status === 'failed' ? 'badge-failed' :
          executionLog.status === 'complete' ? 'badge-success' :
          ''
        }`}>
          {executionLog.status === 'running' && (
            <>
              <span className="spinner-icon"></span>
              <span>{elapsedTime}</span>
            </>
          )}
          {executionLog.status === 'failed' && (
            <span>Failed</span>
          )}
          {executionLog.status === 'complete' && (
            <>
              <span>✓</span>
              <span>Done</span>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '8px' }}>
        <div
          className="task-card-title"
          onClick={() => onTaskClick?.(task)}
          style={{ cursor: 'pointer', flex: 1 }}
        >
          {task.name}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
              fontSize: '18px',
              color: 'var(--text-secondary, #6b7280)',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.color = 'var(--text-primary, #1f2937)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.color = 'var(--text-secondary, #6b7280)';
            }}
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
      <div className="task-card-badges">
        {task.status !== 'Backlog' && task.status !== 'Ready' && (
          <span
            className="task-card-badge"
            style={getStatusBadgeStyle(task.status)}
          >
            {getStatusLabel(task.status)}
          </span>
        )}
        {task.status === 'Merging' && (
          <div style={{
            marginTop: '8px',
            fontSize: '12px',
            fontStyle: 'italic',
            color: '#666',
            animation: 'pulse 1.5s infinite'
          }}>
            Merge in progress...
          </div>
        )}
        {task.is_imported && (
          <span className="badge-readonly">🔒 Read-only (imported)</span>
        )}
      </div>

      {task.status === 'Failed' && (
        <div style={{
          marginTop: '8px',
          padding: '6px 8px',
          backgroundColor: '#fff5f5',
          border: '1px solid #feb2b2',
          borderRadius: '4px',
          fontSize: '11px',
          color: '#742a2a',
          maxHeight: '60px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'normal',
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '2px' }}>Error Details:</div>
          <div style={{ fontSize: '10px', opacity: 0.8 }}>
            Click task to view full error details and suggestions
          </div>
        </div>
      )}
      {task.status === 'Ready' && (
        <button
          onClick={handleExecute}
          disabled={isExecuting}
          style={{
            padding: '6px 12px',
            marginTop: '8px',
            backgroundColor: isExecuting ? '#ccc' : '#0066cc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isExecuting ? 'not-allowed' : 'pointer',
            width: '100%',
            fontSize: '12px',
            fontWeight: 'bold',
          }}
        >
          {isExecuting ? 'Executing...' : 'Execute'}
        </button>
      )}
      {task.status === 'Review' && (
        <button
          onClick={() => onReviewClick?.(task.id, task.name)}
          style={{
            padding: '6px 12px',
            marginTop: '8px',
            backgroundColor: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            width: '100%',
            fontSize: '12px',
            fontWeight: 'bold',
          }}
          title="View diff and approve/reject changes"
        >
          Review
        </button>
      )}
      {task.status === 'Failed' && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={handleRetry}
            disabled={isRetrying || isAborting}
            style={{
              flex: 1,
              minWidth: '60px',
              padding: '6px 8px',
              backgroundColor: isRetrying ? '#ccc' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: isRetrying ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              fontWeight: 'bold',
            }}
            title="Retry execution with same command"
          >
            {isRetrying ? '⏳' : '🔄 Resume'}
          </button>
          <button
            onClick={handleAbort}
            disabled={isAborting || isRetrying}
            style={{
              flex: 1,
              minWidth: '60px',
              padding: '6px 8px',
              backgroundColor: isAborting ? '#ccc' : '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: isAborting ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              fontWeight: 'bold',
            }}
            title="Mark task as failed and stop recovery"
          >
            {isAborting ? '⏳' : '⏹️ Abort'}
          </button>
          <button
            onClick={() => onTaskClick?.(task)}
            disabled={isRetrying || isAborting}
            style={{
              flex: 1,
              minWidth: '80px',
              padding: '6px 8px',
              backgroundColor: (isRetrying || isAborting) ? '#ccc' : '#8b5cf6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: (isRetrying || isAborting) ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              fontWeight: 'bold',
            }}
            title="Attach terminal to debug"
          >
            🔌 Terminal
          </button>
        </div>
      )}
      {task.status === 'InProgress' && executionLog && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
          {executionLog.status === 'running' && (
            <button
              onClick={handlePause}
              disabled={isPauseLoading}
              style={{
                flex: 1,
                minWidth: '80px',
                padding: '6px 8px',
                backgroundColor: isPauseLoading ? '#ccc' : '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isPauseLoading ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
              }}
              title="Pause execution without terminating process"
            >
              {isPauseLoading ? '⏳' : '⏸️ Pause'}
            </button>
          )}
          {executionLog.status === 'paused' && (
            <button
              onClick={handleResume}
              disabled={isPauseLoading}
              style={{
                flex: 1,
                minWidth: '80px',
                padding: '6px 8px',
                backgroundColor: isPauseLoading ? '#ccc' : '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isPauseLoading ? 'not-allowed' : 'pointer',
                fontSize: '11px',
                fontWeight: 'bold',
              }}
              title="Resume paused execution"
            >
              {isPauseLoading ? '⏳' : '▶️ Resume'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
