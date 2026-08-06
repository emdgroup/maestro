import { useState, useMemo, useRef } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { Plus, Archive, Search, BellDot } from "lucide-react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { BoardView } from "@/views/kanban/board-view/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { useReviewPanelTaskId, useBoardActions } from "@/store/boardStore";
import { TaskDetailModal } from "@/components/kanban/task-detail-modal/TaskDetailModal.tsx";
import { TaskReviewPanel } from "@/components/execution/diff/TaskReviewPanel";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/ui/input-group";
import { Badge } from "@/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Checkbox } from "@/ui/checkbox";
import { Button, buttonVariants } from "@/ui/button";
import type { Task, TaskPriority } from "@/types/bindings";
import { PRIORITIES } from "@/utils/constants/priority";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { ArchiveModal } from "@/components/kanban/archive-modal/ArchiveModal";
import { useKanban } from "@/contexts/KanbanContext";
import { useQueueDrain } from "@/utils/hooks/useQueueDrain";
import { QueueCapacityBadge } from "@/components/kanban/QueueCapacityBadge";

const EMPTY_TASKS: Task[] = [];

export const KanbanView: React.FC = () => {
  const activeTaskId = useActiveTaskId();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;
  const projectPath = selectedProject?.path ?? "";
  const { data: tasks } = useTasksQuery(projectId);
  const taskList = tasks ?? EMPTY_TASKS;
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath);
  const reviewPanelTaskId = useReviewPanelTaskId();
  const { closeReview } = useBoardActions();
  const { connection } = useKanban();

  // Mounted here rather than in `BoardView` because this view stays mounted while the user is on
  // another tab — auto-mode has to keep filling slots when nobody is watching the board, which is
  // most of the time it matters.
  useQueueDrain(projectId, projectPath, taskList, connection);

  const [query, setQuery] = useState("");
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [needsMeOnly, setNeedsMeOnly] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
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

  // `ball` is "who is the pipeline blocked on", not "who owns this", so a Planning backlog and
  // queued tasks are excluded by design — otherwise the count would be the size of the board.
  const needsMeCount = useMemo(() => taskList.filter((t) => t.ball === "User").length, [taskList]);

  const filteredTasks = taskList.filter((t) => {
    const matchesQuery = query === "" || t.title.toLowerCase().includes(query.toLowerCase());
    const matchesPriority =
      selectedPriorities.length === 0 || selectedPriorities.includes(t.priority);
    const matchesLabel =
      selectedLabels.length === 0 || selectedLabels.some((l) => t.labels.includes(l));
    const matchesNeedsMe = !needsMeOnly || t.ball === "User";
    return matchesQuery && matchesPriority && matchesLabel && matchesNeedsMe;
  });

  const reviewTask =
    reviewPanelTaskId != null ? taskList.find((t) => t.id === reviewPanelTaskId) : null;
  const reviewWorktree =
    reviewPanelTaskId != null
      ? (worktrees ?? []).find((w) => w.task_id === reviewPanelTaskId)
      : null;

  if (reviewPanelTaskId != null && reviewTask) {
    return (
      <TaskReviewPanel
        task={reviewTask}
        // A task with isolation off never gets a worktree row — its agent worked in the project
        // itself — so the diff has to be taken there. Kept separate from `worktreePath`, which
        // still means "there is a worktree", because Discard offers to delete whatever that names.
        reviewPath={
          reviewWorktree?.path ?? (reviewTask.isolated_worktree ? null : projectPath || null)
        }
        worktreePath={reviewWorktree?.path ?? null}
        baseBranch={reviewWorktree?.base_branch ?? reviewTask.base_branch ?? null}
        branchName={reviewWorktree?.branch_name ?? null}
        onClose={closeReview}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 bg-card flex items-center px-4 gap-2 shrink-0">
        {/* Search */}
        <ShortcutHint shortcutId="focus-search">
          <InputGroup className="w-48 bg-muted!">
            <InputGroupInput
              ref={searchInputRef}
              type="text"
              placeholder="Search tasks..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-48 text-sm"
            />
            <InputGroupAddon align="inline-start">
              <Search className="text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
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
                <Button
                  variant="ghost"
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 h-auto p-0 w-full justify-start"
                  onClick={() => setSelectedPriorities([])}
                >
                  Clear
                </Button>
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
                <Button
                  variant="ghost"
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 h-auto p-0 w-full justify-start"
                  onClick={() => setSelectedLabels([])}
                >
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <QueueCapacityBadge projectId={projectId} />

        <Button
          size="sm"
          variant={needsMeOnly ? "accent" : "outline"}
          onClick={() => setNeedsMeOnly((v) => !v)}
          disabled={needsMeCount === 0 && !needsMeOnly}
          title="Show only tasks the pipeline is waiting on you for"
        >
          <BellDot className="size-4" />
          Needs me
          {needsMeCount > 0 && <Badge variant="secondary">{needsMeCount}</Badge>}
        </Button>

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
      <TaskDetailModal taskId={activeTaskId} />
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
        <BoardView tasks={filteredTasks} />
      </div>
    </div>
  );
};
