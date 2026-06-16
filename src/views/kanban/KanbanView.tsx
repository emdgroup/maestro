import { useState, useMemo, useRef, useCallback } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { Plus, Archive } from "lucide-react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { BoardView } from "@/views/kanban/board-view/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { TaskDetailScreen } from "@/views/kanban/task-detail/TaskDetailScreen";
import { TaskReviewPanel } from "@/components/execution/diff/TaskReviewPanel";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { Input } from "@/ui/input";
import { Badge } from "@/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Checkbox } from "@/ui/checkbox";
import { Button, buttonVariants } from "@/ui/button";
import type { Task, TaskPriority } from "@/types/bindings";
import { PRIORITIES } from "@/utils/constants/priority";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { ArchiveModal } from "@/components/kanban/archive-modal/ArchiveModal";

const EMPTY_TASKS: Task[] = [];

export const KanbanView: React.FC = () => {
  const activeTaskId = useActiveTaskId();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;
  const projectPath = selectedProject?.path ?? "";
  const { data: tasks } = useTasksQuery(projectId);
  const taskList = tasks ?? EMPTY_TASKS;
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath);
  const worktreeTaskIds = useMemo(
    () => new Set((worktrees ?? []).filter((w) => w.task_id != null).map((w) => w.task_id!)),
    [worktrees],
  );

  const [query, setQuery] = useState("");
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
  const [reviewPanelTaskId, setReviewPanelTaskId] = useState<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useShortcuts("board", {
    "board-new": () => setIsCreateModalOpen(true),
    "focus-search": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  });

  const availableLabels = useMemo(
    () => [...new Set(taskList.flatMap((t) => t.labels))].sort(),
    [taskList],
  );

  const filteredTasks = taskList.filter((t) => {
    const matchesQuery = query === "" || t.title.toLowerCase().includes(query.toLowerCase());
    const matchesPriority =
      selectedPriorities.length === 0 || selectedPriorities.includes(t.priority);
    const matchesLabel =
      selectedLabels.length === 0 || selectedLabels.some((l) => t.labels.includes(l));
    return matchesQuery && matchesPriority && matchesLabel;
  });

  const reviewTask =
    reviewPanelTaskId != null ? taskList.find((t) => t.id === reviewPanelTaskId) : null;
  const reviewWorktree =
    reviewPanelTaskId != null
      ? (worktrees ?? []).find((w) => w.task_id === reviewPanelTaskId)
      : null;

  const handleReviewClose = useCallback(() => setReviewPanelTaskId(null), []);
  const handleReviewClick = useCallback((taskId: number) => setReviewPanelTaskId(taskId), []);

  if (activeTaskId !== null) {
    return <TaskDetailScreen taskId={activeTaskId} />;
  }

  if (reviewPanelTaskId != null && reviewTask) {
    return (
      <TaskReviewPanel
        task={reviewTask}
        worktreePath={reviewWorktree?.path ?? null}
        baseBranch={reviewWorktree?.base_branch ?? reviewTask.base_branch ?? null}
        branchName={reviewWorktree?.branch_name ?? null}
        onClose={handleReviewClose}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-border bg-muted/30 flex items-center px-4 gap-2 shrink-0">
        {/* Search */}
        <ShortcutHint shortcutId="focus-search">
          <Input
            ref={searchInputRef}
            placeholder="Search tasks..."
            className="h-8 w-48"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </ShortcutHint>

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
              {PRIORITIES.map((p) => (
                <label key={p} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <Checkbox
                    checked={selectedPriorities.includes(p)}
                    onCheckedChange={(checked) => {
                      setSelectedPriorities((prev) =>
                        checked ? [...prev, p] : prev.filter((x) => x !== p),
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
              {availableLabels.map((label) => (
                <label key={label} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <Checkbox
                    checked={selectedLabels.includes(label)}
                    onCheckedChange={(checked) => {
                      setSelectedLabels((prev) =>
                        checked ? [...prev, label] : prev.filter((x) => x !== label),
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

        <Button size="sm" variant="outline" onClick={() => setIsArchiveModalOpen(true)}>
          <Archive className="size-4" />
          Archive
        </Button>

        <div className="ml-auto">
          <ShortcutHint shortcutId="board-new">
            <Button
              variant="accent"
              size="sm"
              className="h-8 text-xs bg-clip-border"
              onClick={() => setIsCreateModalOpen(true)}
            >
              <Plus className="size-3.5 mr-1" />
              New Task
            </Button>
          </ShortcutHint>
        </div>
      </div>
      {projectId !== null && (
        <>
          <CreateTaskModal
            isOpen={isCreateModalOpen}
            onClose={() => setIsCreateModalOpen(false)}
            projectId={projectId}
          />
          <ArchiveModal
            isOpen={isArchiveModalOpen}
            onClose={() => setIsArchiveModalOpen(false)}
            projectId={projectId}
          />
        </>
      )}
      <div className="flex-1 min-h-0">
        <BoardView
          tasks={filteredTasks}
          worktreeTaskIds={worktreeTaskIds}
          onReviewClick={handleReviewClick}
        />
      </div>
    </div>
  );
};
