import React, { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "../types/bindings";
import { useBoardStore } from "../store/boardStore";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
  projectPath?: string;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false, projectPath = "" }) => {
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
      // Phase 5 will add terminal UI
    } catch (error) {
      console.error('Execution failed:', error);
      // Phase 8 will add error notification UI
    } finally {
      setIsExecuting(false);
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
      <div className="task-card-title">{task.name}</div>
      {task.is_imported && (
        <div className="task-card-badges">
          <span className="badge-readonly">🔒 Read-only (imported)</span>
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
    </div>
  );
};
