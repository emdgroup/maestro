import type { Task, TaskPriority } from "@/types/bindings";

/// Highest first. The queue is sorted by this, so a card's position and its priority are two
/// views of one fact — which is why dragging edits the priority rather than a separate order
/// field that could disagree with it.
const PRIORITY_ORDER: TaskPriority[] = ["Urgent", "High", "Medium", "Low", "None"];

function rank(priority: TaskPriority): number {
  const index = PRIORITY_ORDER.indexOf(priority);
  return index === -1 ? PRIORITY_ORDER.length - 1 : index;
}

/**
 * The priority a card must take to sit between two neighbours.
 *
 * A clamp, not an adoption: the card keeps what it had whenever that already fits, so dragging a
 * card past several others of the same priority does not silently promote it. It moves only as far
 * as it must to keep the list coherent.
 *
 * Each bound exists only when that neighbour does, which is what makes the edges fall out instead
 * of needing rules of their own — a drop at the top has only a lower bound, so it rises to meet the
 * card below it and may sit higher; a drop at the bottom has only an upper bound.
 *
 * The window can never be empty, because the list it is read from is already sorted by priority.
 */
export function clampPriority(
  current: TaskPriority,
  above: TaskPriority | undefined,
  below: TaskPriority | undefined,
): TaskPriority {
  const highest = above === undefined ? 0 : rank(above);
  const lowest = below === undefined ? PRIORITY_ORDER.length - 1 : rank(below);

  return PRIORITY_ORDER[Math.min(Math.max(rank(current), highest), lowest)];
}

/**
 * The priority a task should take after being dropped at `index` in `queueOrder`.
 *
 * Returns null when nothing has to change, so the caller can leave the priority out of its update
 * rather than writing a value identical to the stored one.
 *
 * `queueOrder` is the post-drop ordering including the dragged task, which is how the drag library
 * reports it; the neighbours are therefore the entries either side of `index`.
 */
export function priorityAfterDrop(
  queueOrder: number[],
  taskId: number,
  tasks: Task[],
): TaskPriority | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const task = byId.get(taskId);
  if (!task) return null;

  const index = queueOrder.indexOf(taskId);
  if (index === -1) return null;

  const next = clampPriority(
    task.priority,
    byId.get(queueOrder[index - 1])?.priority,
    byId.get(queueOrder[index + 1])?.priority,
  );

  return next === task.priority ? null : next;
}
