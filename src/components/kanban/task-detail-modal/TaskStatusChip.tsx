import type { CSSProperties } from "react";
import type { Task, TaskStatus } from "@/types/bindings";
import { colors } from "@/components/kanban/kanban-column/KanbanColumn";
import { gateLine, loopLine } from "@/components/kanban/loop/loop-state";
import {
  COMPLETION_LABELS,
  PHASE_LABELS,
  USER_GATE_LABELS,
} from "@/components/kanban/task-card/phase-labels";

const STATUS_NAMES: Record<TaskStatus, string> = {
  Planning: "Planning",
  Queue: "Queue",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
  Cancelled: "Cancelled",
};

/** What the task is doing within its column, or `null` when the column says it all. */
export function statusDetail(task: Task): string | null {
  const gate = gateLine(task);
  if (gate) return [gate.label, gate.detail].filter(Boolean).join(", ");
  // The label alone: a loop's detail is its agent's last words, which the Loop tab shows in full.
  const loop = loopLine(task);
  if (loop) return loop.label;
  if (task.status === "Done") {
    return task.completion ? (COMPLETION_LABELS[task.completion] ?? null) : null;
  }
  if (task.status === "Queue" && task.phase == null) {
    return task.execute_requested_at ? "waiting for a slot" : null;
  }
  if (task.phase == null) return null;
  if (task.phase_status === "Blocked") return "needs your answer";
  if (task.phase_status === "Failed") return `${PHASE_LABELS[task.phase]}, stopped`;
  if (task.ball === "User") return USER_GATE_LABELS[task.phase] ?? "waiting on you";
  if (task.phase_status === "Waiting") return `${PHASE_LABELS[task.phase]}, waiting for a slot`;
  return PHASE_LABELS[task.phase];
}

/** The task's column and what it is doing there. Read only: a task moves by its actions. */
export function TaskStatusChip({ task }: { task: Task }) {
  const detail = statusDetail(task);
  const live = task.phase_status === "Running";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-foreground/7 bg-background/50 px-2.5 py-1 text-xs"
      style={{ "--status-color": colors[task.status] } as CSSProperties}
    >
      <span
        className={`size-2 shrink-0 rounded-full bg-(--status-color) ${live ? "animate-pulse" : ""}`}
      />
      <span className="shrink-0">{STATUS_NAMES[task.status]}</span>
      {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
    </span>
  );
}
