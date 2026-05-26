import { useState } from "react";
import { useActiveTerminalTaskId, useIsTerminalOpen, useBoardActions } from "@/store/boardStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/KanbanColumn";
import { ReviewModal } from "@/components/common/ReviewModal";
import { TaskSettingsModal } from "@/components/task/TaskSettingsModal";
import { ExecutionTerminal } from "@/components/execution/ExecutionTerminal";
import { useKanban } from "@/contexts/KanbanContext";
import { useArchiveTaskMutation } from "@/services/task.service";

const BOARD_STATUSES: Array<TaskStatus> = ["Backlog", "Ready", "InProgress", "Review", "Done"];

const COLUMN_TITLES: Partial<Record<TaskStatus, string>> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

interface BoardViewProps {
  tasks: Task[];
}

export function BoardView({ tasks }: BoardViewProps) {
  const { projectId } = useKanban();

  const activeTerminalTaskId = useActiveTerminalTaskId();
  const isTerminalOpen = useIsTerminalOpen();
  const { closeTerminal } = useBoardActions();

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");
  const [selectedTaskForSettings, setSelectedTaskForSettings] = useState<Task | null>(null);

  const archiveTask = useArchiveTaskMutation();

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-5 p-4 bg-background flex-1">
        {BOARD_STATUSES.map((status) => {
          const columnTasks =
            status === "Done"
              ? tasks.filter((t) => t.status === status && !t.archived_at)
              : tasks.filter((t) => t.status === status);
          return (
            <KanbanColumn
              key={status}
              columnTitle={COLUMN_TITLES[status]!}
              tasks={columnTasks}
              status={status}
              onReviewClick={(taskId, taskName) => {
                setSelectedTaskId(taskId);
                setSelectedTaskName(taskName);
                setReviewModalOpen(true);
              }}
              onSettingsClick={(task) => setSelectedTaskForSettings(task)}
              onArchiveClick={(taskId) => archiveTask.mutate(taskId)}
            />
          );
        })}
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
            tasks.find((t) => t.id === activeTerminalTaskId)?.title ||
            `Task ${activeTerminalTaskId}`
          }
          isActive={true}
          onClose={closeTerminal}
        />
      )}
    </div>
  );
}
