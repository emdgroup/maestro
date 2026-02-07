import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { Task } from "../types/bindings";
import { TaskCard } from "./TaskCard";

interface KanbanColumnProps {
  columnId: string;
  columnTitle: string;
  tasks: Task[];
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
  onReviewClick?: (taskId: number, taskName: string) => void;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  columnId,
  columnTitle,
  tasks,
  projectPath = "",
  onTaskClick,
  onReviewClick,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: columnId,
  });

  return (
    <div className="kanban-column">
      <div className="kanban-column-header">
        {columnTitle} <span className="kanban-column-count">({tasks.length})</span>
      </div>
      <div
        ref={setNodeRef}
        className={`kanban-drop-zone ${isOver ? "drag-over-valid" : ""}`}
      >
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} projectPath={projectPath} onTaskClick={onTaskClick} onReviewClick={onReviewClick} />
        ))}
      </div>
    </div>
  );
};
