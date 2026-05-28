import { Task } from "@/types/bindings";
import { useKanban } from "@/contexts/KanbanContext";
import { useExecuteTask, useTaskActiveSession } from "@/hooks/useExecuteTask";
import { useInterruptTaskMutation, useArchiveTaskMutation } from "@/services/task.service";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { ShieldAlert } from "lucide-react";
import { PRIORITY_COLORS } from "@/utils/constants/priority";

interface TaskCardProps {
  task: Task;
  onReviewClick?: (taskId: number, taskName: string) => void;
  worktreeTaskIds: Set<number>;
}

export function TaskCard({ task, onReviewClick, worktreeTaskIds }: TaskCardProps) {
  const { projectId, projectPath, connectionId, wslConnectionId } = useKanban();
  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();
  const { execute: handleExecute, isExecuting } = useExecuteTask(
    projectId,
    projectPath,
    connectionId,
    wslConnectionId,
  );
  const interruptTask = useInterruptTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const activeSession = useTaskActiveSession(task.status === "InProgress" ? task.id : null);

  const hasMetadata = task.priority !== "None" || task.labels.length > 0 || task.auto_approve;

  return (
    <div
      className="rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 cursor-pointer hover:shadow-md hover:border-ring"
      onClick={() => setActiveTaskId(task.id)}
    >
      {/* Row 1: Title */}
      <p className="text-sm font-medium text-foreground line-clamp-2">{task.title}</p>

      {/* Row 2: Metadata (priority dot + labels + auto-approve) */}
      {hasMetadata && (
        <div className="flex items-center gap-1.5 mt-1.5">
          {task.priority !== "None" && (
            <span
              style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
              className="h-[7px] w-[7px] rounded-full shrink-0 inline-block"
            />
          )}
          {task.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-xs text-muted-foreground">+{task.labels.length - 3}</span>
          )}
          {task.auto_approve && (
            <ShieldAlert className="h-3.5 w-3.5 text-amber-500 ml-auto shrink-0" />
          )}
        </div>
      )}

      {/* Row 3: Footer (worktree badge left, action button right) */}
      <div className="flex items-center justify-between mt-2">
        <div>
          {worktreeTaskIds.has(task.id) && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              worktree
            </span>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {task.status === "Ready" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void handleExecute(task);
              }}
              disabled={isExecuting}
              className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {isExecuting ? "..." : "▶ Execute"}
            </button>
          )}
          {task.status === "InProgress" && (
            <>
              {activeSession && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate({ agentId: String(task.id) });
                  }}
                  className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90"
                >
                  Join
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  interruptTask.mutate(task.id);
                }}
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80"
              >
                ⏹ Interrupt
              </button>
            </>
          )}
          {task.status === "Review" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReviewClick?.(task.id, task.title);
              }}
              className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Review
            </button>
          )}
          {task.status === "Done" && !task.archived_at && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                archiveTask.mutate(task.id);
              }}
              className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80"
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
