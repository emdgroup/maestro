import { Task, TaskStatus } from "@/types/bindings";
import { TaskCard } from "../task-card/TaskCard";
import { useDroppable } from "@dnd-kit/react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { pointerIntersection } from "@dnd-kit/collision";
import { CSSProperties } from "react";
import { Inbox, Clock, RefreshCw, Eye, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
  // The accent, as "working" is on Home. Amber is kept for a task that needs the user.
  InProgress: "var(--accent)",
  Review: "var(--color-purple-500)",
  Done: "var(--color-green-500)",
  Cancelled: "var(--destructive)",
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
  // Each line has to describe what this board actually does. They used to promise a parallel
  // limit and an AI reviewer, neither of which exists.
  Queue: {
    icon: <Clock className="size-5" />,
    title: "Queue is empty",
    sub: "Drag a task here once it is ready to run",
  },
  InProgress: {
    icon: <RefreshCw className="size-5" />,
    title: "Nothing running",
    sub: "Execute a task to put an agent on it",
  },
  Review: {
    icon: <Eye className="size-5" />,
    title: "No tasks in review",
    sub: "Tasks arrive here when an agent finishes",
  },
  Done: {
    icon: <CheckCircle2 className="size-5" />,
    title: "Nothing done yet",
    sub: "Approved tasks land here",
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
    // A glass pane of Home's, with the status as a dot and the count as a scoreboard number.
    <div
      style={{ "--column-color": colors[status] } as CSSProperties}
      className={cn(
        "home-glass flex flex-col rounded-[18px] overflow-hidden transition-all duration-150",
        isDimmed && "opacity-35",
      )}
    >
      <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-[15px] tracking-[-0.025em] text-foreground">
          <span className="size-2 rounded-full bg-(--column-color)" />
          {columnTitle}
        </h3>
        <span
          className={cn(
            "text-[22px] leading-none font-semibold tracking-[-0.025em] tabular-nums",
            tasks.length ? "text-(--column-color)" : "text-muted-foreground/40",
          )}
        >
          {tasks.length}
        </span>
      </div>
      <div
        ref={ref}
        className={cn(
          "flex-1 overflow-y-auto px-2.5 pt-0.5 pb-2.5 transition-all duration-150",
          isHighlighted && getDropTargetClass(status),
        )}
      >
        {tasks.length === 0 && COLUMN_EMPTY_STATE[status] && (
          <div className="border-[1.5px] border-dashed border-foreground/18 rounded-[14px] p-5 flex flex-col items-center gap-2 text-center w-full text-muted-foreground">
            <div className="p-2 [&>svg]:stroke-[1.5]">{COLUMN_EMPTY_STATE[status].icon}</div>
            <p className="text-xs font-medium">{COLUMN_EMPTY_STATE[status].title}</p>
            <p className="text-[11px] opacity-70 leading-snug">{COLUMN_EMPTY_STATE[status].sub}</p>
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
