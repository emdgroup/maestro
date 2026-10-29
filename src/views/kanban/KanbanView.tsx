import { useState, useMemo, useRef } from "react";
import { useShortcuts } from "@/hooks/useShortcuts";
import { Plus, Archive, Search, BellDot, Repeat } from "lucide-react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { BoardView } from "@/views/kanban/board-view/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { useReviewPanelTaskId, useBoardActions } from "@/store/boardStore";
import { TaskDetailModal } from "@/components/kanban/task-detail-modal/TaskDetailModal";
import { TaskReviewPanel } from "@/components/execution/diff/TaskReviewPanel";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/ui/input-group";
import { Badge } from "@/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Checkbox } from "@/ui/checkbox";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import type { RunMode, Task, TaskPriority } from "@/types/bindings";
import { PRIORITIES } from "@/utils/constants/priority";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { ArchiveModal } from "@/components/kanban/archive-modal/ArchiveModal";
import { usePullRequestPoll } from "@/hooks/usePullRequestPoll";
import { QueueCapacityBadge } from "@/components/kanban/QueueCapacityBadge";
import { AutoModeToggle } from "@/components/kanban/AutoModeToggle";
import { SEGMENT_GROUP, SEGMENT_ITEM } from "@/lib/segmented";

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

  // The daemon drives the pipeline; the forge is the window's, so pull requests are polled here,
  // where it keeps running while the user is on another tab.
  usePullRequestPoll(projectId, taskList);

  const [query, setQuery] = useState("");
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [needsMeOnly, setNeedsMeOnly] = useState(false);
  const [runMode, setRunMode] = useState<RunMode | null>(null);
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
    const matchesRunMode = runMode === null || t.run_mode === runMode;
    return matchesQuery && matchesPriority && matchesLabel && matchesNeedsMe && matchesRunMode;
  });

  const reviewTask =
    reviewPanelTaskId != null ? taskList.find((t) => t.id === reviewPanelTaskId) : null;
  const reviewWorktree =
    reviewPanelTaskId != null
      ? (worktrees ?? []).find((w) => w.task_id === reviewPanelTaskId)
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Over the board rather than in place of it. A review is a pass across a task's changes,
          not a destination — leaving the board visible behind it says so, and says which board
          you come back to. Neither Escape nor a click on the margin closes it: the sheet holds
          unsent comments and a scope you set up, and the ways out are the ones that decide
          something — Approve, Rework, Discard, or the bar's own close. */}
      <Dialog
        open={reviewPanelTaskId != null && reviewTask != null}
        onOpenChange={(open, details) => {
          if (open) return;
          if (details.reason === "escape-key" || details.reason === "outside-press") return;
          closeReview();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100vw-2.5rem)] h-[calc(100vh-2.5rem)] max-w-none sm:max-w-none flex flex-col p-0 gap-0 overflow-hidden"
        >
          <DialogTitle className="sr-only">Review {reviewTask?.title ?? "task"}</DialogTitle>
          {reviewTask && (
            <TaskReviewPanel
              task={reviewTask}
              // A task with isolation off never gets a worktree row — its agent worked in the
              // project itself — so the diff has to be taken there. Kept separate from
              // `worktreePath`, which still means "there is a worktree", because Discard offers
              // to delete whatever that names.
              reviewPath={
                reviewWorktree?.path ??
                (reviewTask.workspace_mode === "RepositoryDirectory" ? projectPath || null : null)
              }
              worktreePath={reviewWorktree?.path ?? null}
              baseBranch={reviewWorktree?.base_branch ?? reviewTask.base_branch ?? null}
              branchName={reviewWorktree?.branch_name ?? null}
              onClose={closeReview}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* No surface of its own: the toolbar sits on the window's accent tint, as Home's panels do,
          and its buttons are Home's connection buttons. */}
      <div className="h-12 flex items-center px-4 gap-2 shrink-0">
        {/* Search */}
        <ShortcutHint shortcutId="focus-search">
          <InputGroup className="home-field w-48 rounded-xl">
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
          <PopoverTrigger className="home-pane h-8 gap-2 rounded-xl px-3.5 text-xs font-medium flex cursor-pointer items-center">
            {selectedPriorities.length > 0 ? (
              <Badge variant="secondary">Priority · {selectedPriorities.length}</Badge>
            ) : (
              "Priority"
            )}
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1.5 gap-0" align="start">
            <div className="flex flex-col">
              {PRIORITIES.map((p) => (
                <label
                  key={p}
                  className="flex items-center gap-2.5 cursor-pointer rounded-[10px] px-2.5 py-1.5 hover:bg-foreground/7"
                >
                  <Checkbox
                    checked={selectedPriorities.includes(p)}
                    onCheckedChange={(checked) => {
                      setSelectedPriorities((prev) =>
                        checked ? [...prev, p] : prev.filter((x) => x !== p),
                      );
                    }}
                  />
                  <span className="text-[13px]">{p}</span>
                </label>
              ))}
              {selectedPriorities.length > 0 && (
                <Button
                  variant="ghost"
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 h-auto rounded-none border-t border-foreground/8 px-2.5 pt-2 pb-1 w-full justify-start hover:bg-transparent"
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
          <PopoverTrigger className="home-pane h-8 gap-2 rounded-xl px-3.5 text-xs font-medium flex cursor-pointer items-center">
            {selectedLabels.length > 0 ? (
              <Badge variant="secondary">Label · {selectedLabels.length}</Badge>
            ) : (
              "Label"
            )}
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1.5 gap-0" align="start">
            <div className="flex flex-col">
              {availableLabels.length === 0 && (
                <span className="px-2.5 py-1.5 text-xs text-muted-foreground">No labels</span>
              )}
              {availableLabels.map((label) => (
                <label
                  key={label}
                  className="flex items-center gap-2.5 cursor-pointer rounded-[10px] px-2.5 py-1.5 hover:bg-foreground/7"
                >
                  <Checkbox
                    checked={selectedLabels.includes(label)}
                    onCheckedChange={(checked) => {
                      setSelectedLabels((prev) =>
                        checked ? [...prev, label] : prev.filter((x) => x !== label),
                      );
                    }}
                  />
                  <span className="text-[13px]">{label}</span>
                </label>
              ))}
              {selectedLabels.length > 0 && (
                <Button
                  variant="ghost"
                  className="text-xs text-muted-foreground hover:text-foreground mt-1 h-auto rounded-none border-t border-foreground/8 px-2.5 pt-2 pb-1 w-full justify-start hover:bg-transparent"
                  onClick={() => setSelectedLabels([])}
                >
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* How each task runs. One choice, so the group always has exactly one pressed. */}
        <ToggleGroup
          aria-label="How tasks run"
          spacing={1}
          className={SEGMENT_GROUP}
          value={[runMode ?? "All"]}
          onValueChange={(values) => {
            const picked = values.find((v) => v !== (runMode ?? "All"));
            if (picked) setRunMode(picked === "All" ? null : (picked as RunMode));
          }}
        >
          <ToggleGroupItem value="All" size="sm" className={SEGMENT_ITEM}>
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="Pipeline" size="sm" className={SEGMENT_ITEM}>
            Pipeline
          </ToggleGroupItem>
          <ToggleGroupItem value="Loop" size="sm" className={SEGMENT_ITEM}>
            <Repeat className="size-3" />
            Loops
          </ToggleGroupItem>
        </ToggleGroup>

        <QueueCapacityBadge projectId={projectId} />

        <AutoModeToggle projectId={projectId} />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setNeedsMeOnly((v) => !v)}
                disabled={needsMeCount === 0 && !needsMeOnly}
                data-selected={needsMeOnly}
                data-attention={needsMeCount > 0 && !needsMeOnly}
                className="home-pane h-8 gap-2 rounded-xl px-3.5 text-xs font-medium data-[attention=true]:text-amber-600 dark:data-[attention=true]:text-amber-400"
              />
            }
          >
            <BellDot className="size-4" />
            Needs me
            {needsMeCount > 0 && (
              <span className="text-[13px] font-semibold tabular-nums">{needsMeCount}</span>
            )}
          </TooltipTrigger>
          <TooltipContent>Show only tasks the pipeline is waiting on you for</TooltipContent>
        </Tooltip>

        <Button
          size="sm"
          variant="ghost"
          className="home-pane h-8 gap-2 rounded-xl px-3.5 text-xs font-medium"
          onClick={() => setIsArchiveModalOpen(true)}
        >
          <Archive className="size-4" />
          Archive
        </Button>

        <div className="ml-auto">
          <ShortcutHint shortcutId="board-new">
            <Button
              variant="accent"
              size="sm"
              className="h-8 rounded-xl px-4 text-xs bg-clip-border"
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
