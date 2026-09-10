import type { TaskPriority } from "@/types/bindings";
import { PriorityPicker } from "./PriorityPicker";

/**
 * What a task decides for itself here, which is only how urgent it is.
 *
 * The agent and the permission mode belong to the project's profiles — a task that wants
 * different ones picks a *profile* through the override dialog. Where it runs belongs to the
 * workspace selector, next to the branch it depends on. Two places to say the same thing is how a
 * task ends up pinned to a mode its role cannot use.
 */
interface TaskMetadataPillsProps {
  priority: TaskPriority;
  onPriorityChange?: (p: TaskPriority) => void;
}

export function TaskMetadataPills({ priority, onPriorityChange }: TaskMetadataPillsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <PriorityPicker value={priority} onChange={onPriorityChange} />
    </div>
  );
}
