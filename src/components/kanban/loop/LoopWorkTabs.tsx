import type { Task } from "@/types/bindings";
import { useLoopNotesQuery } from "@/services/loop.service";

/** The worker's own notes, which every fresh session reads first. */
export function LoopNotesTab({ task }: { task: Task }) {
  const { data: notes } = useLoopNotesQuery(task.project_id, task.id);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        <span className="font-mono">.maestro/loop/PROGRESS.md</span> in the loop's worktree, written
        by the agent. Every fresh session reads it first.{" "}
        <span className="font-mono">.maestro/</span> is excluded from git, so it is never committed.
      </p>
      <pre className="whitespace-pre-wrap rounded-lg border border-border bg-card p-3 font-mono text-[11px] leading-relaxed">
        {notes?.trim() || "Empty"}
      </pre>
    </div>
  );
}
