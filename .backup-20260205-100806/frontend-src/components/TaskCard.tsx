import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Task } from "../types/bindings";

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, isDragging = false }) => {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : "grab",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
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
