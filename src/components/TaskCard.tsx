import React, { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "../types/bindings";
import { useBoardStore } from "../store/boardStore";
import { showErrorToast, showSuccessToast } from "./ErrorToast";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false, projectPath = "", onTaskClick }) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const store = useBoardStore();

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
      case 'Done':
        return { backgroundColor: '#dcfce7', color: '#166534' }; // Green
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
      case 'Done':
        return '✅ Done';
      case 'Backlog':
        return '📋 Backlog';
      case 'Ready':
        return '🚀 Ready';
      default:
        return status;
    }
  };

  return (
    <div
      ref={!isDragging ? setNodeRef : undefined}
      style={style}
      {...(!isDragging && !task.is_imported ? listeners : {})}
      {...(!isDragging && !task.is_imported ? attributes : {})}
      className={`task-card ${task.is_imported ? 'task-card-imported' : ''}`}
    >
      <div
        className="task-card-title"
        onClick={() => onTaskClick?.(task)}
        style={{ cursor: 'pointer' }}
      >
        {task.name}
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
        {task.is_imported && (
          <span className="badge-readonly">🔒 Read-only (imported)</span>
        )}
      </div>
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
    </div>
  );
};
