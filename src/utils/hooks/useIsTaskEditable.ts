import { useSelectedProject } from "@/store/projectStore";
import { useTasksQuery } from "@/services/task.service";

export function useIsTaskEditable(taskId: number | null): boolean {
  const project = useSelectedProject();
  const { data: tasks } = useTasksQuery(project?.id ?? null);
  const task = taskId != null ? (tasks ?? []).find((t) => t.id === taskId) : undefined;
  return task?.status === "Planning";
}
