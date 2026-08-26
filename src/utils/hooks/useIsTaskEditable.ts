import { useSelectedProject } from "@/store/projectStore";
import { useTasksQuery } from "@/services/task.service";

/**
 * Whether the task's own fields can be edited by hand.
 *
 * Planning is a working column, not a parked one: a refiner runs there and rewrites the very
 * description this gates. Editing underneath it would have the user and the agent overwriting each
 * other, and would make the proposal gate meaningless — it compares against a description that had
 * stopped being the one the refiner was given.
 *
 * Gated on there being no pipeline activity at all rather than on the refiner specifically, because
 * a task claimed for execution is also mid-flight even though its column has not changed yet.
 */
export function useIsTaskEditable(taskId: number | null): boolean {
  const project = useSelectedProject();
  const { data: tasks } = useTasksQuery(project?.id ?? null);
  const task = taskId != null ? (tasks ?? []).find((t) => t.id === taskId) : undefined;
  return task?.status === "Planning" && task.phase == null;
}
