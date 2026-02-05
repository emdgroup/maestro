import React from "react";
import { Draggable } from "@hello-pangea/dnd";
import { Task } from "../types/bindings";

interface TaskCardProps {
  task: Task;
  index: number;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, index }) => {
  return (
    <Draggable draggableId={task.id.toString()} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={`task-card ${snapshot.isDragging ? "dragging" : ""}`}
        >
          <h4 className="task-card-title">{task.name}</h4>
          {task.is_imported && (
            <span className="task-card-imported">Imported</span>
          )}
        </div>
      )}
    </Draggable>
  );
};
