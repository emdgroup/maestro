import React, { useEffect, useState } from "react";
import {
  DragDropContext,
  DropResult,
  DragStart,
} from "@hello-pangea/dnd";
import { invoke } from "@tauri-apps/api/core";
import { useBoardStore } from "../store/boardStore";
import { Task, TaskStatus } from "../types/bindings";
import { KanbanColumn } from "./KanbanColumn";
import "../styles/KanbanBoard.css";

interface KanbanBoardProps {
  projectId: number;
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

export const KanbanBoard: React.FC<KanbanBoardProps> = ({ projectId }) => {
  const { loadTasks, updateTaskStatus, getTasksByStatus } = useBoardStore();
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const handleDragStart = (_start: DragStart) => {
    // Reserved for future drag state tracking
  };

  const handleDragEnd = async (result: DropResult) => {
    const { source, destination, draggableId } = result;

    // If no destination, card was dropped outside valid zone
    if (!destination) {
      return;
    }

    // If dropped in same position, no change needed
    if (
      source.droppableId === destination.droppableId &&
      source.index === destination.index
    ) {
      return;
    }

    const taskId = parseInt(draggableId, 10);
    const fromStatus = source.droppableId as TaskStatus;
    const toStatus = destination.droppableId as TaskStatus;

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
      <DragDropContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="kanban-board">
          {COLUMN_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              columnId={status}
              columnTitle={COLUMN_TITLES[status]}
              tasks={getTasksByStatus(status)}
            />
          ))}
        </div>
      </DragDropContext>
    </div>
  );
};
