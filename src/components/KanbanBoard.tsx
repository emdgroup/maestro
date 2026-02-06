import React, { useEffect, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { invoke } from "../lib/tauri-mock";
import { useBoardStore } from "../store/boardStore";
import { Task, TaskStatus } from "../types/bindings";
import { KanbanColumn } from "./KanbanColumn";
import { TaskCard } from "./TaskCard";
import "../styles/KanbanBoard.css";

interface KanbanBoardProps {
  projectId: number;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
}

const COLUMN_STATUSES: Array<TaskStatus> = [
  "Backlog",
  "Ready",
  "InProgress",
  "Review",
  "Done",
];

const COLUMN_TITLES: Record<TaskStatus, string> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

export const KanbanBoard: React.FC<KanbanBoardProps> = ({ projectId, projectPath = "", onTaskClick }) => {
  const { loadTasks, updateTaskStatus, getTasksByStatus, getTasks } = useBoardStore();
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  // Load tasks on mount
  useEffect(() => {
    const fetchTasks = async () => {
      try {
        setIsLoading(true);
        const tasks = await invoke<Task[]>("get_tasks", { project_id: projectId });
        loadTasks(tasks);
        setErrorMessage(null);
      } catch (err) {
        console.error("Failed to load tasks:", err);
        setErrorMessage("Failed to load tasks. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchTasks();
  }, [projectId, loadTasks]);

  const isValidTransition = (
    _fromStatus: TaskStatus,
    _toStatus: TaskStatus,
    _taskId: number
  ): boolean => {
    // For MVP: allow free movement between Backlog and Ready
    // Other columns are managed by agents (in future phases)
    // For now, allow all transitions (validation will be added in Phase 3)
    return true;
  };

  const handleDragStart = (event: { active: { id: string | number } }) => {
    const taskId = typeof event.active.id === 'string'
      ? parseInt(event.active.id, 10)
      : event.active.id;
    const task = getTasks().find((t) => t.id === taskId);
    setActiveTask(task || null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) {
      return;
    }

    const taskId = typeof active.id === 'string' ? parseInt(active.id, 10) : active.id;
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
      // Update task status in database
      await invoke("update_task", {
        task_id: taskId,
        status: toStatus,
      });

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

  return (
    <div>
      {errorMessage && (
        <div style={{
          padding: "1rem",
          marginBottom: "1rem",
          backgroundColor: "#fee2e2",
          color: "#991b1b",
          borderRadius: "0.375rem",
        }}>
          {errorMessage}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="kanban-board">
          {COLUMN_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              columnId={status}
              columnTitle={COLUMN_TITLES[status]}
              tasks={getTasksByStatus(status)}
              projectPath={projectPath}
              onTaskClick={onTaskClick}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? (
            <div style={{ opacity: 0.8 }}>
              <TaskCard task={activeTask} isDragging />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
