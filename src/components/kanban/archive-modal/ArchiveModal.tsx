import { useState, useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { useTasksQuery } from "@/services/task.service";
import { useNavigationActions } from "@/store/navigationStore";
import type { Task, TaskStatus } from "@/types/bindings";
import { PRIORITY_BADGE_CLASSES } from "@/utils/constants/priority";

type ArchiveFilter = "all" | "Done" | "Cancelled";

const STATUS_BADGE_CLASSES: Partial<Record<TaskStatus, string>> = {
  Done: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  Cancelled: "bg-destructive/15 text-destructive border border-destructive/30",
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

interface ArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
}

export function ArchiveModal({ isOpen, onClose, projectId }: ArchiveModalProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArchiveFilter>("all");

  const { data: tasks, isLoading } = useTasksQuery(projectId);
  const { setActiveTaskId } = useNavigationActions();

  useEffect(() => {
    if (!isOpen) {
      setSearch("");
      setFilter("all");
    }
  }, [isOpen]);

  const archiveTasks = useMemo<Task[]>(() => {
    return (
      (tasks ?? [])
        // Include archived tasks and Cancelled tasks (cancel_task always sets archived_at, but guard by status too)
        .filter((t) => t.archived_at != null || t.status === "Cancelled")
        .filter((t) => filter === "all" || t.status === filter)
        .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    );
  }, [tasks, filter, search]);

  function handleTaskClick(task: Task) {
    setActiveTaskId(task.id);
    onClose();
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[80vh]">
        <DialogTitle>Archive</DialogTitle>
        <DialogDescription className="sr-only">
          Browse archived and cancelled tasks
        </DialogDescription>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search archived tasks..."
          className="h-8"
        />

        <Tabs value={filter} onValueChange={(v) => setFilter(v as ArchiveFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="Done">Done</TabsTrigger>
            <TabsTrigger value="Cancelled">Cancelled</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">Loading...</p>
          ) : archiveTasks.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">No archived tasks</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1 p-1">
              {archiveTasks.map((task) => (
                <button
                  key={task.id}
                  className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/5 transition-colors text-left w-full"
                  onClick={() => handleTaskClick(task)}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate block">
                      {task.title}
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
      </DialogContent>
    </Dialog>
  );
}
