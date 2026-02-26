import { KanbanBoard } from "@/components/kanban";
import type { Task } from "@/types/bindings";

interface KanbanViewProps {
  projectId: number;
  projectPath?: string;
  onTaskClick?: (task: Task) => void;
}

/**
 * KanbanView - Page-level orchestrator for the Kanban board screen
 * Composes the main task management interface with drag-and-drop task organization
 */
export const KanbanView: React.FC<KanbanViewProps> = ({
  projectId,
  projectPath = "",
  onTaskClick,
}) => {
  return (
    <KanbanBoard
      projectId={projectId}
      projectPath={projectPath}
      onTaskClick={onTaskClick}
    />
  );
};
