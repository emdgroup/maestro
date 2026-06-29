import { useState, useRef, useEffect, useMemo } from "react";
import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import { move } from "@dnd-kit/helpers";
import { useActiveTerminalTaskId, useIsTerminalOpen, useBoardActions } from "@/store/boardStore";
import { useIsGitRepo } from "@/store/projectStore";
import { useDefaultAgent } from "@/store/configStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/kanban-column/KanbanColumn";
import { ExecutionTerminal } from "@/components/execution/terminal/ExecutionTerminal";
import { AgentPickerModal } from "@/components/execution/AgentPickerModal";
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
}

export function BoardView({ tasks }: BoardViewProps) {
  const activeTerminalTaskId = useActiveTerminalTaskId();
  const isTerminalOpen = useIsTerminalOpen();
  const { closeTerminal } = useBoardActions();
  const updateTask = useUpdateTask();
  const isGitRepo = useIsGitRepo();
  const defaultAgent = useDefaultAgent();

  const statuses = useMemo(
    () => (isGitRepo ? BOARD_STATUSES : BOARD_STATUSES.filter((s) => s !== "Review")),
    [isGitRepo],
  );

  const [dndItems, setDndItems] = useState<DndItems>(() => buildDndItems(tasks));
  const [agentPickerState, setAgentPickerState] = useState<{
    task: Task;
    proceed: () => void;
  } | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);

  const highlightedColumn: DndGroup | null =
    isDragActive && draggingTask
      ? dndItems.Ready.includes(draggingTask.id)
        ? "Ready"
        : "Backlog"
      : null;

  const liveDndRef = useRef<DndItems>(dndItems);
  const previousDndRef = useRef<DndItems>(dndItems);

  const stableDndItems = useMemo(() => buildDndItems(tasks), [tasks]);

  useEffect(() => {
    if (!isDragActive) {
      setDndItems(stableDndItems);
      liveDndRef.current = stableDndItems;
    }
  }, [stableDndItems, isDragActive]);

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
          const taskId = source.id as number;
          const tentative = move(liveDndRef.current, event);
          const wasInBacklog = liveDndRef.current.Backlog.includes(taskId);
          const nowInBacklog = tentative.Backlog.includes(taskId);
          if (wasInBacklog === nowInBacklog) return;
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

          const newStatus: DndGroup | null = final.Ready.includes(taskId)
            ? "Ready"
            : final.Backlog.includes(taskId)
              ? "Backlog"
              : null;
          const oldStatus: DndGroup = prev.Ready.includes(taskId) ? "Ready" : "Backlog";

          if (!newStatus || newStatus === oldStatus) return;

          const doUpdate = () =>
            updateTask.mutate(
              { taskId, updates: { status: newStatus } },
              {
                onError: () => {
                  liveDndRef.current = previousDndRef.current;
                  setDndItems({ ...previousDndRef.current });
                },
              },
            );

          const task = tasks.find((t) => t.id === taskId);
          if (newStatus === "Ready" && !task?.agent_id && !defaultAgent) {
            setAgentPickerState({ task: task!, proceed: doUpdate });
          } else {
            doUpdate();
          }
        }}
      >
        <div
          className={`grid p-4 bg-background flex-1 min-h-0 overflow-hidden`}
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
      {agentPickerState && (
        <AgentPickerModal
          open
          task={agentPickerState.task}
          proceed={(_agentId) => {
            agentPickerState.proceed();
            setAgentPickerState(null);
          }}
          onClose={() => {
            liveDndRef.current = previousDndRef.current;
            setDndItems({ ...previousDndRef.current });
            setAgentPickerState(null);
          }}
        />
      )}
    </div>
  );
}
