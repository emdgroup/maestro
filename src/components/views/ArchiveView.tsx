import { useTasksQuery } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import type { Task, TaskStatus } from "@/types/bindings";

const STATUS_BADGE_CLASSES: Partial<Record<TaskStatus, string>> = {
  Done: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  Cancelled: "bg-destructive/15 text-destructive border border-destructive/30",
};

const PRIORITY_BADGE_CLASSES: Record<string, string> = {
  Urgent: "bg-destructive/15 text-destructive border border-destructive/30",
  High: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  Medium: "bg-accent/15 text-accent-foreground border border-accent/30",
  Low: "bg-muted text-muted-foreground border border-border",
};

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

type ArchiveFilter = "all" | "Done" | "Cancelled";

interface ArchiveViewProps {
  search: string;
  filter: ArchiveFilter;
}

export function ArchiveView({ search, filter }: ArchiveViewProps) {
  const { projectId, onTaskClick } = useKanban();

  const { data: tasks, isLoading } = useTasksQuery(projectId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading tasks...
      </div>
    );
  }

  const archiveTasks: Task[] = (tasks ?? [])
    .filter((t) => t.archived_at != null || t.status === "Cancelled")
    .filter((t) => filter === "all" || t.status === filter)
    .filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return (
    <div className="flex-1 overflow-y-auto h-full">
      {archiveTasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
          <p className="text-sm">No archived tasks</p>
          {search && <p className="text-xs">Try adjusting your search</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-4">
          {archiveTasks.map((task) => (
            <button
              key={task.id}
              className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/5 transition-colors text-left w-full"
              onClick={() => onTaskClick(task)}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground truncate block">
                  {task.name}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{formatDate(task.updated_at)}</span>

                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE_CLASSES[task.priority]}`}
                >
                  {task.priority}
                </span>

                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE_CLASSES[task.status] ?? ""}`}
                >
                  {task.status}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
