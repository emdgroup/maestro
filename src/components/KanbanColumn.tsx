import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { Task, TaskStatus } from "../types/bindings";
import { TaskCard } from "./TaskCard";
import { Badge } from "./ui/badge";

interface KanbanColumnProps {
  columnId: string;
  columnTitle: string;
  tasks: Task[];
  status: TaskStatus;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
  onReviewClick?: (taskId: number, taskName: string) => void;
  onSettingsClick?: (task: Task) => void;
}

const getColumnBorderColor = (status: TaskStatus): string => {
  const colors: Record<TaskStatus, string> = {
    Backlog: "border-l-slate-400",
    Ready: "border-l-blue-500",
    InProgress: "border-l-amber-500",
    Review: "border-l-purple-500",
    Merging: "border-l-purple-500",
    Done: "border-l-green-500",
    Failed: "border-l-red-500",
  };
  return colors[status] || "border-l-slate-400";
};

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  columnId,
  columnTitle,
  tasks,
  status,
  projectPath = "",
  onTaskClick,
  onReviewClick,
  onSettingsClick,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: columnId,
  });

  const borderColor = getColumnBorderColor(status);

  return (
    <div className={`flex flex-col rounded-lg border border-border bg-card shadow-sm overflow-hidden border-l-4 ${borderColor}`}>
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <h3 className="font-semibold text-base text-foreground">{columnTitle}</h3>
        <Badge variant="secondary" className="h-5 px-2 text-xs">
          {tasks.length}
        </Badge>
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
