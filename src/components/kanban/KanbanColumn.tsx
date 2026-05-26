import { Task, TaskStatus } from "@/types/bindings";
import { TaskCard } from "./TaskCard";
import { Badge } from "@/ui/badge";

interface KanbanColumnProps {
  columnTitle: string;
  tasks: Task[];
  status: TaskStatus;
  onReviewClick?: (taskId: number, taskName: string) => void;
}

const getColumnBorderColor = (status: TaskStatus): string => {
  const colors: Record<TaskStatus, string> = {
    Backlog: "border-t-slate-400",
    Ready: "border-t-blue-500",
    InProgress: "border-t-amber-500",
    Review: "border-t-purple-500",
    Done: "border-t-green-500",
    Cancelled: "border-t-destructive",
  };
  return colors[status] || "border-l-slate-400";
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

export function KanbanColumn({
  columnTitle,
  tasks,
  status,
  onReviewClick,
}: KanbanColumnProps) {
  const borderColor = getColumnBorderColor(status);
  const badgeColor = getBadgeColor(status);

  return (
    <div
      className={`flex flex-col first:rounded-l-lg last:rounded-r-lg border border-border bg-card shadow-sm overflow-hidden border-t-4 ${borderColor}`}
    >
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <h3 className="font-semibold text-base text-foreground">{columnTitle}</h3>
        <Badge className={`h-5 px-2 text-xs border-0 ${badgeColor}`}>{tasks.length}</Badge>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onReviewClick={onReviewClick}
          />
        ))}
      </div>
    </div>
  );
}
