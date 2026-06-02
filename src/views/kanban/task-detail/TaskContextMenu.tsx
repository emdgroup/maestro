import { Task } from "@/types/bindings";

interface TaskContextMenuProps {
  task: Task;
  isOpen: boolean;
  onClose: () => void;
  onEditSettings: (task: Task) => void;
}

export function TaskContextMenu({ task, isOpen, onClose, onEditSettings }: TaskContextMenuProps) {
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
}
