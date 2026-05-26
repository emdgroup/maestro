import { Task, TaskPriority } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { useExecuteTask } from "@/hooks/useExecuteTask";
import { useNavigationActions } from "@/store/navigationStore";

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  Urgent: "#f87171",
  High: "#fb923c",
  Medium: "#facc15",
  Low: "#4ade80",
  None: "#4b5563",
};

interface TaskCardProps {
  task: Task;
  onReviewClick?: (taskId: number, taskName: string) => void;
}

export function TaskCard({ task, onReviewClick }: TaskCardProps) {
  const { projectId, projectPath } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const { execute: handleExecute, isExecuting } = useExecuteTask(projectId, projectPath);

  return (
    <div
      className="rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 cursor-pointer hover:shadow-md hover:border-ring"
      onClick={() => setActiveTaskId(task.id)}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-2 flex-1">
          <div className="font-base text-foreground truncate">{task.title}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 items-center">
        {task.priority !== "None" && (
          <span
            style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
            className="h-[7px] w-[7px] rounded-full shrink-0 inline-block"
          />
        )}
        {task.labels.length > 0 &&
          task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="inline-block px-2 py-0.5 text-xs rounded bg-muted text-muted-foreground"
            >
              {label}
            </span>
          ))}
        {task.labels.length > 3 && (
          <span className="text-xs text-muted-foreground">+{task.labels.length - 3} more</span>
        )}
      </div>

      {task.status === "Ready" && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void handleExecute(task)}
            disabled={isExecuting}
            className={`flex-1 px-3 py-2 text-sm font-semibold rounded transition-all duration-200 ${
              isExecuting
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-accent text-accent-foreground hover:shadow-md"
            }`}
          >
            {isExecuting ? "Executing..." : "Execute"}
          </button>
        </div>
      )}
      {task.status === "Review" && (
        <button
          onClick={() => onReviewClick?.(task.id, task.title)}
          className="mt-2 w-full px-3 py-2 text-sm font-semibold rounded bg-secondary text-secondary-foreground hover:shadow-md transition-all duration-200"
          title="View diff and approve/reject changes"
        >
          Review
        </button>
      )}
      {task.status === "Done" && !task.archived_at && (
        <button
          onClick={() => {}}
          className="mt-2 w-full px-3 py-2 text-sm font-semibold rounded bg-muted text-muted-foreground hover:bg-muted/80 hover:shadow-md transition-all duration-200"
          title="Archive this task"
        >
          Archive
        </button>
      )}
    </div>
  );
}
