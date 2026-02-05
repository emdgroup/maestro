import React from "react";
import { Droppable } from "@hello-pangea/dnd";
import { Task, TaskStatus } from "../types/bindings";
import { TaskCard } from "./TaskCard";

interface KanbanColumnProps {
  columnId: string;
  columnTitle: string;
  tasks: Task[];
  isInvalidDropZone?: boolean;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  columnId,
  columnTitle,
  tasks,
  isInvalidDropZone = false,
}) => {
  return (
    <div className="kanban-column">
      <div className="kanban-column-header">
        {columnTitle} <span className="kanban-column-count">({tasks.length})</span>
      </div>
      <Droppable droppableId={columnId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`kanban-drop-zone ${
              snapshot.isDraggingOver && !isInvalidDropZone
                ? "drag-over-valid"
                : isInvalidDropZone && snapshot.isDraggingOver
                  ? "drag-over-invalid"
                  : ""
            }`}
          >
            {tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
};
