import { Task, TaskStatus } from "@/types/bindings";
import { TaskCard } from "../task-card/TaskCard";
import { Badge } from "@/ui/badge";
import { useDroppable } from "@dnd-kit/react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { pointerIntersection } from "@dnd-kit/collision";
import { CSSProperties } from "react";
import { Inbox, Clock, RefreshCw, Eye, CheckCircle2 } from "lucide-react";

interface KanbanColumnProps {
  columnTitle: string;
  tasks: Task[];
  status: TaskStatus;
  isDragActive: boolean;
  isHighlighted?: boolean;
}

export const colors: Record<TaskStatus, string> = {
  Planning: "var(--color-slate-400)",
  Queue: "var(--color-blue-500)",
  InProgress: "var(--color-amber-500)",
  Review: "var(--color-purple-500)",
  Done: "var(--color-green-500)",
  Cancelled: "var(--destructive)",
};

const getBadgeColor = (status: TaskStatus): string => {
  const colors: Record<TaskStatus, string> = {
    Planning: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    Queue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    InProgress: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    Review: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    Done: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    Cancelled: "bg-destructive/15 text-destructive",
  };
  return colors[status] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
};

const getDropTargetClass = (status: TaskStatus): string => {
  if (status === "Queue") return "ring-[1.5px] ring-inset ring-blue-500/30 bg-blue-500/5";
  if (status === "Planning") return "ring-[1.5px] ring-inset ring-slate-400/30 bg-slate-400/5";
  return "";
};

const COLUMN_EMPTY_STATE: Partial<
  Record<TaskStatus, { icon: React.ReactNode; title: string; sub: string }>
> = {
  Planning: {
    icon: <Inbox className="size-5" />,
    title: "No tasks planned",
    sub: "Add a task to get started",
  },
  Queue: {
    icon: <Clock className="size-5" />,
    title: "Queue is empty",
    sub: "Tasks wait here when the parallel limit is reached",
  },
  InProgress: {
    icon: <RefreshCw className="size-5" />,
    title: "Nothing running",
    sub: "Start a task from Planning",
  },
  Review: {
    icon: <Eye className="size-5" />,
    title: "No tasks in review",
    sub: "AI will review completed tasks",
  },
  Done: {
    icon: <CheckCircle2 className="size-5" />,
    title: "Nothing done yet",
    sub: "Completed tasks appear here",
  },
};

export function KanbanColumn({
  columnTitle,
  tasks,
  status,
  isDragActive,
  isHighlighted,
}: KanbanColumnProps) {
  const isDndColumn = status === "Planning" || status === "Queue";
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
      className={`flex flex-col first:rounded-l-lg last:rounded-r-lg border border-border bg-background shadow-sm overflow-hidden border-t-4 border-t-(--column-border-color) transition-all duration-150 ${isDimmed ? "opacity-35" : ""}`}
    >
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <h3 className="font-semibold text-base text-foreground">{columnTitle}</h3>
        <Badge className={`h-5 px-2 text-xs border-0 ${badgeColor}`}>{tasks.length}</Badge>
      </div>
      <div
        ref={ref}
        className={`flex-1 overflow-y-auto custom-scrollbar p-3 transition-all duration-150 ${isHighlighted ? getDropTargetClass(status) : ""}`}
      >
        {tasks.length === 0 && COLUMN_EMPTY_STATE[status] && (
          <div className="border border-dashed border-border rounded-lg p-5 flex flex-col items-center gap-2 text-center w-full">
            <div className="text-muted-foreground/40 rounded-full p-2 bg-muted">
              {COLUMN_EMPTY_STATE[status].icon}
            </div>
            <p className="text-xs font-medium text-muted-foreground">
              {COLUMN_EMPTY_STATE[status].title}
            </p>
            <p className="text-xs text-muted-foreground/50 leading-snug">
              {COLUMN_EMPTY_STATE[status].sub}
            </p>
          </div>
        )}
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
