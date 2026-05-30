import { useState, useRef, useEffect } from "react";
import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { move } from "@dnd-kit/helpers";
import { useActiveTerminalTaskId, useIsTerminalOpen, useBoardActions } from "@/store/boardStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/KanbanColumn";
import { ReviewModal } from "@/components/common/ReviewModal";
import { ExecutionTerminal } from "@/components/execution/ExecutionTerminal";
import { useUpdateTask } from "@/services/task.service";

const BOARD_STATUSES: Array<TaskStatus> = ["Backlog", "Ready", "InProgress", "Review", "Done"];

const COLUMN_TITLES: Partial<Record<TaskStatus, string>> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

type DndGroup = "Backlog" | "Ready";
type DndItems = Record<DndGroup, number[]>;

function buildDndItems(tasks: Task[]): DndItems {
  return {
    Backlog: tasks.filter((t) => t.status === "Backlog").map((t) => t.id),
    Ready: tasks.filter((t) => t.status === "Ready").map((t) => t.id),
  };
}

interface BoardViewProps {
  tasks: Task[];
  worktreeTaskIds: Set<number>;
}

export function BoardView({ tasks, worktreeTaskIds }: BoardViewProps) {
  const activeTerminalTaskId = useActiveTerminalTaskId();
  const isTerminalOpen = useIsTerminalOpen();
  const { closeTerminal } = useBoardActions();
  const updateTask = useUpdateTask();

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");

  const [dndItems, setDndItems] = useState<DndItems>(() => buildDndItems(tasks));
  const [isDragActive, setIsDragActive] = useState(false);
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);

  const liveDndRef = useRef<DndItems>(dndItems);
  const previousDndRef = useRef<DndItems>(dndItems);

  useEffect(() => {
    if (!isDragActive) {
      const next = buildDndItems(tasks);
      setDndItems(next);
      liveDndRef.current = next;
    }
  }, [tasks, isDragActive]);

  const getColumnTasks = (status: TaskStatus): Task[] => {
    if (status === "Done") {
      return tasks.filter((t) => t.status === status && !t.archived_at);
    }
    if (status === "Backlog" || status === "Ready") {
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
          const newItems = move(liveDndRef.current, event);
          liveDndRef.current = newItems;
          setDndItems({ ...newItems });
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

          const newStatus: DndGroup | null = final.Ready.includes(taskId)
            ? "Ready"
            : final.Backlog.includes(taskId)
              ? "Backlog"
              : null;
          const oldStatus: DndGroup = prev.Ready.includes(taskId) ? "Ready" : "Backlog";

          if (!newStatus || newStatus === oldStatus) return;

          updateTask.mutate(
            { taskId, updates: { status: newStatus } },
            {
              onError: () => {
                liveDndRef.current = previousDndRef.current;
                setDndItems({ ...previousDndRef.current });
              },
            },
          );
        }}
      >
        <div className="grid grid-cols-5 p-4 bg-background flex-1 min-h-0 overflow-hidden">
          {BOARD_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              columnTitle={COLUMN_TITLES[status]!}
              tasks={getColumnTasks(status)}
              status={status}
              isDragActive={isDragActive}
              onReviewClick={(taskId, taskName) => {
                setSelectedTaskId(taskId);
                setSelectedTaskName(taskName);
                setReviewModalOpen(true);
              }}
              worktreeTaskIds={worktreeTaskIds}
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

      {reviewModalOpen && selectedTaskId && (
        <ReviewModal
          taskId={selectedTaskId}
          taskName={selectedTaskName}
          isOpen={reviewModalOpen}
          onClose={() => {
            setReviewModalOpen(false);
            setSelectedTaskId(null);
            setSelectedTaskName("");
          }}
        />
      )}

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
