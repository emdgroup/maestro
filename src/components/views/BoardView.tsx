import { useState } from "react";
import { useActiveTerminalTaskId, useIsTerminalOpen, useBoardActions } from "@/store/boardStore";
import { Task, TaskStatus } from "@/types/bindings";
import { KanbanColumn } from "@/components/kanban/KanbanColumn";
import { ReviewModal } from "@/components/common/ReviewModal";
import { ExecutionTerminal } from "@/components/execution/ExecutionTerminal";

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
  worktreeTaskIds: Set<number>;
}

export function BoardView({ tasks, worktreeTaskIds }: BoardViewProps) {
  const activeTerminalTaskId = useActiveTerminalTaskId();
  const isTerminalOpen = useIsTerminalOpen();
  const { closeTerminal } = useBoardActions();

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTaskName, setSelectedTaskName] = useState<string>("");

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-5 p-4 bg-background flex-1 min-h-0 overflow-hidden">
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
              worktreeTaskIds={worktreeTaskIds}
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
