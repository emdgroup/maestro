import { useState } from "react";
import { useTasksQuery } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import type { Task, TaskStatus } from "@/types/bindings";

type ArchiveFilter = "all" | "Done" | "Cancelled";

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

const FILTER_LABELS: Record<ArchiveFilter, string> = {
  all: "All",
  Done: "Done",
  Cancelled: "Cancelled",
};

export function ArchiveView() {
  const { projectId, onTaskClick } = useKanban();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArchiveFilter>("all");

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
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <input
          type="text"
          placeholder="Search tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-sm h-8 rounded-md border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
          {(["all", "Done", "Cancelled"] as ArchiveFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1 rounded-md font-medium transition-colors ${
                filter === f
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
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
                  <span className="text-xs text-muted-foreground">
                    {formatDate(task.updated_at)}
                  </span>

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
    </div>
  );
}
