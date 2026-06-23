import { Task, TaskStatus } from "@/types/bindings";
import { TaskCard } from "../task-card/TaskCard";
import { Badge } from "@/ui/badge";
import { useDroppable } from "@dnd-kit/react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { pointerIntersection } from "@dnd-kit/collision";
import { CSSProperties } from "react";

interface KanbanColumnProps {
  columnTitle: string;
  tasks: Task[];
  status: TaskStatus;
  isDragActive: boolean;
  isHighlighted?: boolean;
}

export const colors: Record<TaskStatus, string> = {
  Backlog: "var(--color-slate-400)",
  Ready: "var(--color-blue-500)",
  InProgress: "var(--color-amber-500)",
  Review: "var(--color-purple-500)",
  Done: "var(--color-green-500)",
  Cancelled: "var(--destructive)",
};

const getBadgeColor = (status: TaskStatus): string => {
  const colors: Record<TaskStatus, string> = {
    Backlog: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    Ready: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    InProgress: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    Review: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    Done: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    Cancelled: "bg-destructive/15 text-destructive",
  };
  return colors[status] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
};

const getDropTargetClass = (status: TaskStatus): string => {
  if (status === "Ready") return "ring-[1.5px] ring-inset ring-blue-500/30 bg-blue-500/5";
  if (status === "Backlog") return "ring-[1.5px] ring-inset ring-slate-400/30 bg-slate-400/5";
  return "";
};

export function KanbanColumn({
  columnTitle,
  tasks,
  status,
  isDragActive,
  isHighlighted,
}: KanbanColumnProps) {
  const isDndColumn = status === "Backlog" || status === "Ready";
  const badgeColor = getBadgeColor(status);

  const { ref } = useDroppable({
    id: status,
    type: "column",
    accept: ["item"],
    collisionPriority: CollisionPriority.Low,
    collisionDetector: pointerIntersection,
    disabled: !isDndColumn,
  });

  const isDimmed = isDragActive && !isDndColumn;

  return (
    <div
      style={{ "--column-border-color": colors[status] } as CSSProperties}
      className={`flex flex-col first:rounded-l-lg last:rounded-r-lg border border-border bg-card shadow-sm overflow-hidden border-t-4 border-t-(--column-border-color) transition-all duration-150 ${isDimmed ? "opacity-35" : ""}`}
    >
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <h3 className="font-semibold text-base text-foreground">{columnTitle}</h3>
        <Badge className={`h-5 px-2 text-xs border-0 ${badgeColor}`}>{tasks.length}</Badge>
      </div>
      <div
        ref={ref}
        className={`flex-1 overflow-y-auto custom-scrollbar p-3 transition-all duration-150 ${isHighlighted ? getDropTargetClass(status) : ""}`}
      >
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            index={index}
            dndGroup={isDndColumn ? status : undefined}
          />
        ))}
      </div>
    </div>
  );
}
