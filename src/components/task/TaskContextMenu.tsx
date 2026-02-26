import React from "react";
import { Task } from "@/types/bindings";

interface TaskContextMenuProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
  onEditSettings: (task: Task) => void;
}

export const TaskContextMenu: React.FC<TaskContextMenuProps> = ({
  task,
  isOpen,
  onClose,
  onEditSettings,
}) => {
  if (!isOpen) {
    return null;
  }

  const handleEditSettings = () => {
    onEditSettings(task);
    onClose();
  };

  return (
    <div className="task-context-menu">
      <div className="menu-item" onClick={handleEditSettings}>
        Edit Settings
      </div>
    </div>
  );
};
