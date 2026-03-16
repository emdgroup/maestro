import { KanbanBoard } from "@/components/kanban/KanbanBoard";

/**
 * KanbanView - Page-level orchestrator for the Kanban board screen
 * Composes the main task management interface with drag-and-drop task organization
 *
 * Context: Uses KanbanProvider for project data and callbacks (no prop drilling)
 */
export const KanbanView: React.FC = () => {
  return <KanbanBoard />;
};
