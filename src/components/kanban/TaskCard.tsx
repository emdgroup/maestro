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

  const hasMetadata =
    task.priority !== "None" || task.labels.length > 0 || task.auto_approve;

  return (
    <div
      className="rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 cursor-pointer hover:shadow-md hover:border-ring"
      onClick={() => setActiveTaskId(task.id)}
    >
      {/* Row 1: Title */}
      <p className="text-sm font-medium text-foreground line-clamp-2">{task.title}</p>

      {/* Row 2: Metadata (priority dot + labels + auto-approve) */}
      {hasMetadata && (
        <div className="flex items-center gap-1.5 mt-1.5">
          {task.priority !== "None" && (
            <span
              style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
              className="h-[7px] w-[7px] rounded-full shrink-0 inline-block"
            />
          )}
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-xs text-muted-foreground">
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Row 3: Footer (worktree badge left, action button right) */}
      <div className="flex items-center justify-between mt-2">
        <div>{/* worktree badge placeholder — Task 6 */}</div>
        <div className="shrink-0">
          {task.status === "Ready" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleExecute(task);
              }}
              disabled={isExecuting}
              className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {isExecuting ? "..." : "▶ Execute"}
            </button>
          )}
          {task.status === "Review" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReviewClick?.(task.id, task.title);
              }}
              className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Review
            </button>
          )}
          {task.status === "Done" && !task.archived_at && (
            <button
              onClick={(e) => {
                e.stopPropagation();
              }}
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80"
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
