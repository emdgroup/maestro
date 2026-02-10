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
  onSettingsClick?: (task: Task) => void;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  columnId,
  columnTitle,
  tasks,
  projectPath = "",
  onTaskClick,
  onReviewClick,
  onSettingsClick,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: columnId,
  });

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <div className="px-4 py-3 font-semibold text-base text-foreground border-b border-border bg-muted/30">
        {columnTitle} <span className="text-sm text-muted-foreground">({tasks.length})</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 overflow-y-auto p-3 transition-all duration-150 ${
          isOver ? "border-2 border-success bg-success/5" : "border-2 border-transparent"
        }`}
      >
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} projectPath={projectPath} onTaskClick={onTaskClick} onReviewClick={onReviewClick} onSettingsClick={onSettingsClick} />
        ))}
      </div>
    </div>
  );
};
