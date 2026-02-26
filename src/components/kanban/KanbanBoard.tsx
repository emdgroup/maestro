import React, { useEffect, useState, useRef } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { taskService } from "@/services";
import { useBoardStore } from "../../store/boardStore";
import { Task, TaskStatus } from "../../types/bindings";
import { toast } from "sonner";
import { KanbanColumn } from "./KanbanColumn";
import { TaskCard } from "./TaskCard";
import { ReviewModal } from "../common/ReviewModal";
import { TaskSettingsModal } from "../task/TaskSettingsModal";
import { ExecutionTerminal } from "../execution/ExecutionTerminal";

export interface KanbanBoardProps {
  projectId: number;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
}

const COLUMN_STATUSES: Array<TaskStatus> = ["Backlog", "Ready", "InProgress", "Review", "Done"];

const COLUMN_TITLES: Record<TaskStatus, string> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Merging: "Review",
  Failed: "Failed",
  Done: "Done",
};

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  projectId,
  projectPath = "",
  onTaskClick,
}) => {
  const {
    loadTasks,
    updateTaskStatus,
    getTasksByStatus,
    getTasks,
    activeTerminalTaskId,
    isTerminalOpen,
    closeTerminal,
  } = useBoardStore();
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");
  const [selectedTaskForSettings, setSelectedTaskForSettings] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const previousTasksRef = useRef<Map<number, TaskStatus>>(new Map());

  // Load tasks on mount
  useEffect(() => {
    const fetchTasks = async () => {
      try {
        setIsLoading(true);
        const tasks = await taskService.getTasks(projectId);
        loadTasks(tasks);
        setErrorMessage(null);

        // Update previous state for merge detection
        const taskStatusMap = new Map(tasks.map((t) => [t.id, t.status]));
        previousTasksRef.current = taskStatusMap;
      } catch (err) {
        console.error("Failed to load tasks:", err);
        setErrorMessage("Failed to load tasks. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchTasks();

    // Set up periodic refresh to detect merge completion
    const interval = setInterval(async () => {
      try {
        const tasks = await taskService.getTasks(projectId);
        loadTasks(tasks);

        // Detect merge completion (Merging -> Done or Merging -> InProgress on conflict)
        for (const task of tasks) {
          const prevStatus = previousTasksRef.current.get(task.id);
          if (prevStatus === "Merging" && task.status === "Done") {
            toast.success(`✓ Merge complete: "${task.name}" is Done`);
          } else if (prevStatus === "Merging" && task.status === "InProgress") {
            toast.error(`Merge conflict for "${task.name}", task returned to In Progress`);
          }
        }

        const taskStatusMap = new Map(tasks.map((t) => [t.id, t.status]));
        previousTasksRef.current = taskStatusMap;
      } catch (err) {
        console.error("Failed to refresh tasks:", err);
      }
    }, 3000); // Refresh every 3 seconds

    return () => clearInterval(interval);
  }, [projectId, loadTasks]);

  const isValidTransition = (
    _fromStatus: TaskStatus,
    _toStatus: TaskStatus,
    _taskId: number,
  ): boolean => {
    // For MVP: allow free movement between Backlog and Ready
    // Other columns are managed by agents (in future phases)
    // For now, allow all transitions (validation will be added in Phase 3)
    return true;
  };

  const handleDragStart = (event: { active: { id: string | number } }) => {
    const taskId =
      typeof event.active.id === "string" ? parseInt(event.active.id, 10) : event.active.id;
    const task = getTasks().find((t) => t.id === taskId);
    setActiveTask(task || null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) {
      return;
    }

    const taskId = typeof active.id === "string" ? parseInt(active.id, 10) : active.id;
    const task = getTasks().find((t) => t.id === taskId);

    if (!task) {
      return;
    }

    const fromStatus = task.status;
    const toStatus = over.id as TaskStatus;

    if (fromStatus === toStatus) {
      return;
    }

    // Validate the transition
    if (!isValidTransition(fromStatus, toStatus, taskId)) {
      setErrorMessage("Invalid transition for this task");
      return;
    }

    try {
      // Update task status in database using task service
      await taskService.updateTask(taskId, { status: toStatus } as any);

      // Update local store
      updateTaskStatus(taskId, toStatus);
      setErrorMessage(null);
    } catch (err) {
      console.error("Failed to update task:", err);
      setErrorMessage("Failed to update task. Please try again.");
    }
  };

  if (isLoading) {
    return <div className="kanban-board">Loading tasks...</div>;
  }

  // Helper: Get tasks for column, including Merging tasks in Review column
  const getTasksForColumn = (status: TaskStatus): Task[] => {
    const tasks = getTasksByStatus(status);

    // Include Merging tasks in the Review column
    if (status === "Review") {
      const mergingTasks = getTasksByStatus("Merging");
      return [...tasks, ...mergingTasks];
    }

    return tasks;
  };

  return (
    <div className="h-full flex flex-col">
      {errorMessage && (
        <div className="p-4 mb-4 bg-error text-error-foreground rounded-lg">{errorMessage}</div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-5 gap-4 p-4 bg-background flex-1">
          {COLUMN_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              columnId={status}
              columnTitle={COLUMN_TITLES[status]}
              tasks={getTasksForColumn(status)}
              status={status}
              projectPath={projectPath}
              onTaskClick={onTaskClick}
              onReviewClick={(taskId, taskName) => {
                setSelectedTaskId(taskId);
                setSelectedTaskName(taskName);
                setReviewModalOpen(true);
              }}
              onSettingsClick={(task) => setSelectedTaskForSettings(task)}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div className="opacity-50">
              <TaskCard task={activeTask} isDragging />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
      {selectedTaskForSettings && (
        <TaskSettingsModal
          isOpen={selectedTaskForSettings !== null}
          onClose={() => setSelectedTaskForSettings(null)}
          task={selectedTaskForSettings}
          projectId={projectId}
        />
      )}
      {isTerminalOpen && activeTerminalTaskId !== null && (
        <ExecutionTerminal
          taskId={activeTerminalTaskId}
          taskName={
            getTasks().find((t) => t.id === activeTerminalTaskId)?.name ||
            `Task ${activeTerminalTaskId}`
          }
          isActive={true}
          onClose={closeTerminal}
        />
      )}
    </div>
  );
};
