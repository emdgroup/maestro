import { useMemo } from "react";
import type { Task } from "@/types/bindings";
import { Button } from "@/ui/button";
import { useTaskWorktree } from "@/contexts/BoardActionsContext";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { useLoopNotesQuery } from "@/services/loop.service";
import { useBoardActions } from "@/store/boardStore";
import { diffFiles } from "./diff-files";

/** What the loop changed against its base, all iterations together. */
export function LoopChangesTab({ task }: { task: Task }) {
  const worktree = useTaskWorktree(task.id);
  const base = worktree?.base_branch ?? task.base_branch;
  const { data } = useWorktreeDiffQuery(
    task.project_id,
    worktree?.path ?? null,
    { type: "BranchAll", branch: base },
    { refetchInterval: false },
  );
  const files = useMemo(() => diffFiles(data?.diff ?? ""), [data?.diff]);
  const { openReview } = useBoardActions();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Against {base}, all iterations together. Each iteration is also its own commit.
        </p>
        <Button size="sm" variant="outline" onClick={() => openReview(task.id)}>
          Review changes
        </Button>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {files.length === 0 ? (
          <li className="p-3 text-[11px] text-muted-foreground">
            {worktree ? "No changes" : "No worktree yet"}
          </li>
        ) : (
          files.map((file) => (
            <li key={file.path} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <span className="flex-1 truncate font-mono">{file.path}</span>
              <span className="tabular-nums text-success">+{file.added}</span>
              <span className="tabular-nums text-destructive">−{file.removed}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

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
