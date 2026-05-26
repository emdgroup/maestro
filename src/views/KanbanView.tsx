import { BoardView } from "@/components/views/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { TaskDetailScreen } from "@/components/task/TaskDetailScreen";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";

export const KanbanView: React.FC = () => {
  const activeTaskId = useActiveTaskId();
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;
  const { data: tasks } = useTasksQuery(projectId);
  const taskList = tasks ?? [];

  if (activeTaskId !== null) {
    return <TaskDetailScreen taskId={activeTaskId} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0" />
      <div className="flex-1 min-h-0">
        <BoardView tasks={taskList} />
      </div>
    </div>
  );
};
