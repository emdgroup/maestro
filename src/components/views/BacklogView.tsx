import { useState } from "react";
import { Plus } from "lucide-react";
import { useTasksQuery, useDeleteTaskMutation, useUpdateTask } from "@/services/task.service";
import { useKanban } from "@/contexts/KanbanContext";
import { Button } from "@/ui/button";
import { BacklogTaskSheet } from "@/components/kanban/BacklogTaskSheet";
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

interface BacklogViewProps {
  search: string;
  priorityFilter: "All" | TaskPriority;
}

export function BacklogView({ search, priorityFilter }: BacklogViewProps) {
  const { projectId } = useKanban();

  const { data: tasks, isLoading } = useTasksQuery(projectId);
  const deleteMutation = useDeleteTaskMutation();
  const updateMutation = useUpdateTask();

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"create" | "edit">("create");
  const [editingTask, setEditingTask] = useState<Task | null>(null);

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

  const filteredTasks = backlogTasks.filter(
    (t) =>
      (priorityFilter === "All" || t.priority === priorityFilter) &&
      (!search || t.name.toLowerCase().includes(search.toLowerCase())),
  );

  const handlePromote = (task: Task) => {
    updateMutation.mutate({ taskId: task.id, updates: { status: "Ready" } });
  };

  const handleDelete = (task: Task) => {
    deleteMutation.mutate(task.id);
  };

  const openCreate = () => {
    setPanelMode("create");
    setEditingTask(null);
    setPanelOpen(true);
  };

  const openEdit = (task: Task) => {
    setPanelMode("edit");
    setEditingTask(task);
    setPanelOpen(true);
  };

  const closePanel = () => {
    setPanelOpen(false);
  };

  return (
    <div className="flex h-full">
      {/* Left: task list */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Backlog</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tasks waiting to be refined and promoted to the board
            </p>
          </div>
          <Button variant="accent" size="sm" onClick={openCreate} className="h-8">
            <Plus className="w-4 h-4" />
            Add Task
          </Button>
        </div>

        {/* Task list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filteredTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
              {backlogTasks.length === 0 ? (
                <>
                  <p className="text-sm">No tasks in backlog</p>
                  <p className="text-xs">Add a task to get started</p>
                </>
              ) : (
                <p className="text-sm">No tasks match the current filters</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-4">
              {filteredTasks.map((task) => {
                const isSelected = panelOpen && panelMode === "edit" && editingTask?.id === task.id;
                return (
                  <div
                    key={task.id}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors group ${
                      isSelected ? "bg-accent/10 border-accent/40" : "bg-card hover:bg-accent/5"
                    }`}
                  >
                    <button className="flex-1 text-left min-w-0" onClick={() => openEdit(task)}>
                      <span className="text-sm font-medium text-foreground truncate block">
                        {task.name}
                      </span>
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
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: inline detail panel */}
      {panelOpen && (
        <div className="w-[420px] shrink-0 border-l border-border flex flex-col">
          <BacklogTaskSheet
            key={panelMode === "edit" ? (editingTask?.id ?? "edit") : "create"}
            onClose={closePanel}
            mode={panelMode}
            task={editingTask}
            projectId={projectId ?? 0}
          />
        </div>
      )}
    </div>
  );
}
