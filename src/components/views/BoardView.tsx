import { useEffect, useState } from "react";
import { useBoardStore } from "@/store/boardStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/KanbanColumn";
import { ReviewModal } from "@/components/common/ReviewModal";
import { TaskSettingsModal } from "@/components/task/TaskSettingsModal";
import { ExecutionTerminal } from "@/components/execution/ExecutionTerminal";
import { useKanban } from "@/contexts/KanbanContext";
import { useTasksQuery, useArchiveTaskMutation } from "@/services/task.service";

const BOARD_STATUSES: Array<TaskStatus> = ["Ready", "InProgress", "Review", "Done"];

const COLUMN_TITLES: Partial<Record<TaskStatus, string>> = {
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

export function BoardView() {
  const { projectId } = useKanban();

  const {
    loadTasks,
    getTasksByStatus,
    getTasks,
    activeTerminalTaskId,
    isTerminalOpen,
    closeTerminal,
  } = useBoardStore();

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");
  const [selectedTaskForSettings, setSelectedTaskForSettings] = useState<Task | null>(null);

  const { data: tasks, isLoading } = useTasksQuery(projectId);
  const archiveTask = useArchiveTaskMutation();

  useEffect(() => {
    if (tasks) {
      loadTasks(tasks);
    }
  }, [tasks, loadTasks]);

  if (isLoading) {
    return <div className="kanban-board">Loading tasks...</div>;
  }

  const getFilteredTasksByStatus = (status: TaskStatus): Task[] => {
    const statusTasks = getTasksByStatus(status);
    if (status === "Done") {
      return statusTasks.filter((t) => !t.archived_at);
    }
    return statusTasks;
  };

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-4 p-4 bg-background flex-1">
        {BOARD_STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            columnId={status}
            columnTitle={COLUMN_TITLES[status]!}
            tasks={getFilteredTasksByStatus(status)}
            status={status}
            onReviewClick={(taskId, taskName) => {
              setSelectedTaskId(taskId);
              setSelectedTaskName(taskName);
              setReviewModalOpen(true);
            }}
            onSettingsClick={(task) => setSelectedTaskForSettings(task)}
            onArchiveClick={(taskId) => archiveTask.mutate(taskId)}
          />
        ))}
      </div>

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
          isOpen={!!selectedTaskForSettings}
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
}
