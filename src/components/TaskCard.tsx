import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "../types/bindings";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging: isActivelyDragging } = useDraggable({
    id: task.id,
  });

  // If this is the overlay card, don't apply transform
  // If this is being actively dragged, hide it (the overlay will show)
  const style = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    opacity: isActivelyDragging ? 0 : 1,
    cursor: "grab",
  };

  return (
    <div
      ref={!isDragging ? setNodeRef : undefined}
      style={style}
      {...(!isDragging ? listeners : {})}
      {...(!isDragging ? attributes : {})}
      className="task-card"
    >
      <div className="task-card-title">{task.name}</div>
      {task.is_imported && (
        <div className="task-card-badge">
          <span className="badge-imported">Imported</span>
        </div>
      )}
    </div>
  );
};
