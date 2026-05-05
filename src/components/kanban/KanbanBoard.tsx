import { useState } from "react";
import { useBoardStore } from "@/store/boardStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/KanbanColumn";
import { ReviewModal } from "@/components/common/ReviewModal";
import { TaskSettingsModal } from "@/components/task/TaskSettingsModal";
import { ExecutionTerminal } from "@/components/execution/ExecutionTerminal";
import { useKanban } from "@/contexts/KanbanContext";
import { useTasksQuery } from "@/services/task.service";

const COLUMN_STATUSES: Array<TaskStatus> = [
  "Backlog",
  "Ready",
  "InProgress",
  "Review",
  "Done",
  "Cancelled",
];

const COLUMN_TITLES: Record<TaskStatus, string> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
  Cancelled: "Cancelled",
};

export const KanbanBoard = () => {
  const { projectId } = useKanban();

  const { activeTerminalTaskId, isTerminalOpen, closeTerminal } = useBoardStore();

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");
  const [selectedTaskForSettings, setSelectedTaskForSettings] = useState<Task | null>(null);

  const { data: tasks, isLoading } = useTasksQuery(projectId);

  if (isLoading) {
    return <div className="kanban-board">Loading tasks...</div>;
  }

  const taskList = tasks ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-6 p-4 bg-background flex-1">
        {COLUMN_STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            columnId={status}
            columnTitle={COLUMN_TITLES[status]}
            tasks={taskList.filter((t) => t.status === status)}
            status={status}
            onReviewClick={(taskId, taskName) => {
              setSelectedTaskId(taskId);
              setSelectedTaskName(taskName);
              setReviewModalOpen(true);
            }}
            onSettingsClick={(task) => setSelectedTaskForSettings(task)}
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
            taskList.find((t) => t.id === activeTerminalTaskId)?.name ||
            `Task ${activeTerminalTaskId}`
          }
          isActive={true}
          onClose={closeTerminal}
        />
      )}
    </div>
  );
};
