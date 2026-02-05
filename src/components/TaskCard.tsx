import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "../types/bindings";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false }) => {
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
    </div>
  );
};
