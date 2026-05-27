import { useState } from "react";
import { Plus } from "lucide-react";
import { BoardView } from "@/components/views/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { TaskDetailScreen } from "@/components/task/TaskDetailScreen";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Checkbox } from "@/ui/checkbox";
import { Button, buttonVariants } from "@/ui/button";
import type { TaskPriority } from "@/types/bindings";
import { CreateTaskModal } from "@/components/kanban/CreateTaskModal";

export const KanbanView: React.FC = () => {
  const activeTaskId = useActiveTaskId();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;
  const projectPath = selectedProject?.path ?? "";
  const { data: tasks } = useTasksQuery(projectId);
  const taskList = tasks ?? [];
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath);
  const worktreeTaskIds = new Set(
    (worktrees ?? []).filter((w) => w.task_id != null).map((w) => w.task_id!),
  );

  const [query, setQuery] = useState("");
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const availableLabels = [...new Set(taskList.flatMap(t => t.labels))].sort();

  const filteredTasks = taskList.filter(t => {
    const matchesQuery =
      query === "" || t.title.toLowerCase().includes(query.toLowerCase());
    const matchesPriority =
      selectedPriorities.length === 0 || selectedPriorities.includes(t.priority);
    const matchesLabel =
      selectedLabels.length === 0 || selectedLabels.some(l => t.labels.includes(l));
    return matchesQuery && matchesPriority && matchesLabel;
  });

  if (activeTaskId !== null) {
    return <TaskDetailScreen taskId={activeTaskId} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-border bg-muted/30 flex items-center px-4 gap-2 shrink-0">
        {/* Search */}
        <Input
          placeholder="Search tasks..."
          className="h-8 w-48"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />

        {/* Priority filter */}
        <Popover>
          <PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
            {selectedPriorities.length > 0 ? (
              <Badge variant="secondary">Priority · {selectedPriorities.length}</Badge>
            ) : (
              "Priority"
            )}
          </PopoverTrigger>
          <PopoverContent className="w-48 p-2" align="start">
            <div className="flex flex-col gap-1">
              {(["Urgent", "High", "Medium", "Low", "None"] as TaskPriority[]).map(p => (
                <label key={p} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <Checkbox
                    checked={selectedPriorities.includes(p)}
                    onCheckedChange={checked => {
                      setSelectedPriorities(prev =>
                        checked ? [...prev, p] : prev.filter(x => x !== p),
                      );
                    }}
                  />
                  <span className="text-sm">{p}</span>
                </label>
              ))}
              {selectedPriorities.length > 0 && (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 text-left"
                  onClick={() => setSelectedPriorities([])}
                >
                  Clear
                </button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Label filter */}
        <Popover>
          <PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
            {selectedLabels.length > 0 ? (
              <Badge variant="secondary">Label · {selectedLabels.length}</Badge>
            ) : (
              "Label"
            )}
          </PopoverTrigger>
          <PopoverContent className="w-48 p-2" align="start">
            <div className="flex flex-col gap-1">
              {availableLabels.length === 0 && (
                <span className="text-xs text-muted-foreground">No labels</span>
              )}
              {availableLabels.map(label => (
                <label key={label} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <Checkbox
                    checked={selectedLabels.includes(label)}
                    onCheckedChange={checked => {
                      setSelectedLabels(prev =>
                        checked ? [...prev, label] : prev.filter(x => x !== label),
                      );
                    }}
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
              {selectedLabels.length > 0 && (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 text-left"
                  onClick={() => setSelectedLabels([])}
                >
                  Clear
                </button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <div className="ml-auto">
          <Button size="sm" onClick={() => setIsCreateModalOpen(true)}>
            <Plus className="size-4" />
            New Task
          </Button>
        </div>
      </div>
      <CreateTaskModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        projectId={projectId ?? 0}
      />
      <div className="flex-1 min-h-0">
        <BoardView tasks={filteredTasks} worktreeTaskIds={worktreeTaskIds} />
      </div>
    </div>
  );
};
