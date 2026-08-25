import { useState, useRef, useEffect, useMemo } from "react";
import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { move } from "@dnd-kit/helpers";
import { useActiveTerminalTaskId, useIsTerminalOpen, useBoardActions } from "@/store/boardStore";
import { useIsGitRepo } from "@/store/projectStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/kanban-column/KanbanColumn";
import { ExecutionTerminal } from "@/components/execution/terminal/ExecutionTerminal";
import { useUpdateTask } from "@/services/task.service";
import { priorityAfterDrop } from "@/lib/queue-priority";

const BOARD_STATUSES: Array<TaskStatus> = ["Planning", "Queue", "InProgress", "Review", "Done"];

const COLUMN_TITLES: Partial<Record<TaskStatus, string>> = {
  Planning: "Planning",
  Queue: "Queue",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

type DndGroup = "Planning" | "Queue";
type DndItems = Record<DndGroup, number[]>;

function buildDndItems(tasks: Task[]): DndItems {
  return {
    Planning: tasks.filter((t) => t.status === "Planning").map((t) => t.id),
    Queue: tasks.filter((t) => t.status === "Queue").map((t) => t.id),
  };
}

interface BoardViewProps {
  tasks: Task[];
}

export function BoardView({ tasks }: BoardViewProps) {
  const activeTerminalTaskId = useActiveTerminalTaskId();
  const isTerminalOpen = useIsTerminalOpen();
  const { closeTerminal } = useBoardActions();
  const updateTask = useUpdateTask();
  const isGitRepo = useIsGitRepo();

  const statuses = useMemo(
    () => (isGitRepo ? BOARD_STATUSES : BOARD_STATUSES.filter((s) => s !== "Review")),
    [isGitRepo],
  );

  const [dndItems, setDndItems] = useState<DndItems>(() => buildDndItems(tasks));
  const [isDragActive, setIsDragActive] = useState(false);
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);

  const highlightedColumn: DndGroup | null =
    isDragActive && draggingTask
      ? dndItems.Queue.includes(draggingTask.id)
        ? "Queue"
        : "Planning"
      : null;

  const liveDndRef = useRef<DndItems>(dndItems);
  const previousDndRef = useRef<DndItems>(dndItems);

  const stableDndItems = useMemo(() => buildDndItems(tasks), [tasks]);

  // The board owns its own item order while a drag is in flight, so server state is only
  // adopted between drags. Adjusted during render rather than from an effect, which showed
  // the pre-drop order for one frame after every drag.
  const [adoptedDndItems, setAdoptedDndItems] = useState(stableDndItems);
  if (!isDragActive && adoptedDndItems !== stableDndItems) {
    setAdoptedDndItems(stableDndItems);
    setDndItems(stableDndItems);
  }

  useEffect(() => {
    if (!isDragActive) liveDndRef.current = stableDndItems;
  }, [stableDndItems, isDragActive]);

  const getColumnTasks = (status: TaskStatus): Task[] => {
    if (status === "Done") {
      return tasks.filter((t) => t.status === status && !t.archived_at);
    }
    if (status === "Planning" || status === "Queue") {
      return dndItems[status]
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => t != null);
    }
    return tasks.filter((t) => t.status === status);
  };

  return (
    <div className="h-full flex flex-col">
      <DragDropProvider
        onDragStart={(event) => {
          const taskId = event.operation.source?.id as number;
          previousDndRef.current = { ...liveDndRef.current };
          setIsDragActive(true);
          setDraggingTask(tasks.find((t) => t.id === taskId) ?? null);
        }}
        onDragOver={(event) => {
          const { source } = event.operation;
          if (source?.type !== "item") return;
          const taskId = source.id as number;
          const tentative = move(liveDndRef.current, event);
          const wasInPlanning = liveDndRef.current.Planning.includes(taskId);
          const nowInPlanning = tentative.Planning.includes(taskId);
          if (wasInPlanning === nowInPlanning) return;
          liveDndRef.current = tentative;
          setDndItems({ ...tentative });
        }}
        onDragEnd={(event) => {
          setIsDragActive(false);
          setDraggingTask(null);

          if (event.canceled) {
            liveDndRef.current = previousDndRef.current;
            setDndItems({ ...previousDndRef.current });
            return;
          }

          const taskId = event.operation.source?.id as number;
          if (!taskId) return;

          const final = liveDndRef.current;
          const prev = previousDndRef.current;

          const newStatus: DndGroup | null = final.Queue.includes(taskId)
            ? "Queue"
            : final.Planning.includes(taskId)
              ? "Planning"
              : null;
          const oldStatus: DndGroup = prev.Queue.includes(taskId) ? "Queue" : "Planning";

          if (!newStatus || newStatus === oldStatus) return;

          // Position in the Queue *is* priority — the column is sorted by it, so a card that
          // jumped ahead of higher-priority work has to claim that priority or the order it was
          // just given would be undone on the next render.
          //
          // Clamped rather than adopted: a card only moves as far as it must to keep the column
          // coherent, so landing among equals leaves it alone.
          const priority =
            newStatus === "Queue" ? priorityAfterDrop(final.Queue, taskId, tasks) : null;

          // Straight to the update: dropping into Queue used to stop and ask which agent to use,
          // and there is no longer a task-level answer to give. The project's profiles name an
          // agent per role and are resolved when the role starts, so a missing one is a spawn-time
          // failure with a message rather than a modal in the middle of a drag.
          updateTask.mutate(
            {
              taskId,
              updates: { status: newStatus, ...(priority ? { priority } : {}) },
            },
            {
              onError: () => {
                liveDndRef.current = previousDndRef.current;
                setDndItems({ ...previousDndRef.current });
              },
            },
          );
        }}
      >
        <div
          className={`grid p-4 bg-card flex-1 min-h-0 overflow-hidden`}
          style={{ gridTemplateColumns: `repeat(${statuses.length}, minmax(0, 1fr))` }}
        >
          {statuses.map((status) => (
            <KanbanColumn
              key={status}
              columnTitle={COLUMN_TITLES[status]!}
              tasks={getColumnTasks(status)}
              status={status}
              isDragActive={isDragActive}
              isHighlighted={highlightedColumn === status}
            />
          ))}
        </div>
        <DragOverlay>
          {draggingTask && (
            <div className="rounded-lg border border-accent/50 bg-card shadow-xl p-3 rotate-[-1.5deg] scale-[1.03] pointer-events-none">
              <p className="text-sm font-medium text-foreground line-clamp-2">
                {draggingTask.title}
              </p>
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>

      {isTerminalOpen && activeTerminalTaskId !== null && (
        <ExecutionTerminal
          taskId={activeTerminalTaskId}
          taskName={
            tasks.find((t) => t.id === activeTerminalTaskId)?.title ||
            `Task ${activeTerminalTaskId}`
          }
          isActive={true}
          onClose={closeTerminal}
        />
      )}
    </div>
  );
}
