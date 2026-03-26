import { useEffect } from "react";
import { useBoardStore } from "@/store/boardStore";
import { useTasksQuery, useDeleteTaskMutation, useUpdateTask } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import type { Task, TaskPriority } from "@/types/bindings";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

const PRIORITY_BADGE_CLASSES: Record<TaskPriority, string> = {
  Urgent: "bg-destructive/15 text-destructive border border-destructive/30",
  High: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  Medium: "bg-accent/15 text-accent-foreground border border-accent/30",
  Low: "bg-muted text-muted-foreground border border-border",
};

export function BacklogView() {
  const { projectId, onTaskClick } = useKanban();
  const { loadTasks } = useBoardStore();

  const { data: tasks, isLoading } = useTasksQuery(projectId);
  const deleteMutation = useDeleteTaskMutation();
  const updateMutation = useUpdateTask();

  useEffect(() => {
    if (tasks) {
      loadTasks(tasks);
    }
  }, [tasks, loadTasks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading tasks...
      </div>
    );
  }

  const backlogTasks: Task[] = (tasks ?? [])
    .filter((t) => t.status === "Backlog")
    .sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

  const handlePromote = (task: Task) => {
    updateMutation.mutate({ taskId: task.id, updates: { status: "Ready" } });
  };

  const handleDelete = (task: Task) => {
    deleteMutation.mutate(task.id);
  };

  if (backlogTasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <p className="text-sm">No tasks in backlog</p>
        <p className="text-xs">Add a task to get started</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-4 overflow-y-auto">
      {backlogTasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/5 transition-colors group"
        >
          <button
            className="flex-1 text-left min-w-0"
            onClick={() => onTaskClick(task)}
          >
            <span className="text-sm font-medium text-foreground truncate block">{task.name}</span>
          </button>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE_CLASSES[task.priority]}`}
            >
              {task.priority}
            </span>

            <button
              onClick={() => handlePromote(task)}
              disabled={updateMutation.isPending}
              className="text-xs px-2.5 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium disabled:opacity-50"
            >
              Promote
            </button>

            <button
              onClick={() => handleDelete(task)}
              disabled={deleteMutation.isPending}
              className="text-xs px-2.5 py-1 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors font-medium disabled:opacity-50 opacity-0 group-hover:opacity-100"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
