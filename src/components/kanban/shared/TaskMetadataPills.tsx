import type { TaskPriority } from "@/types/bindings";
import { PriorityPicker } from "./PriorityPicker";

/// What a task decides for itself here, which is now only how urgent it is.
///
/// It used to also pick the harness and toggle auto-approve. Both are answered by the project's
/// agent profiles instead: a profile names the agent and the permission mode for its role, and a
/// task that wants a different one picks a *profile* through the override dialog rather than
/// describing an agent the project never defined. Two places to say the same thing is how a task
/// ended up pinned to a mode its role could not use.
///
/// The worktree toggle left for the same reason in reverse: it could only say two of the three
/// places a task can run, and the choice now lives in the workspace selector, next to the branch
/// or workspace it depends on.
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
