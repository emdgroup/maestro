import { NotebookPen } from "lucide-react";
import type { LoopIteration, Task } from "@/types/bindings";
import { plural } from "@/lib/format-utils";
import { MarkdownBlock } from "@/components/common/markdown/MarkdownBlock";

/** The rail runs down the middle of the 72px ring, and the cards start past it. */
export const RAIL = "left-[35px]";
export const INDENT = "pl-[88px]";

export const MARKDOWN_BOX =
  "rounded-lg border border-foreground/7 bg-background/50 p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold";

/** What an iteration changed: `3 files +40 −12`, or that it changed nothing. */
export function Changed({ iteration }: { iteration: LoopIteration }) {
  return iteration.files === 0 ? (
    "No changes"
  ) : (
    <span className="tabular-nums">
      {plural(iteration.files, "file")} <span className="text-success">+{iteration.added}</span>{" "}
      <span className="text-destructive">−{iteration.removed}</span>
    </span>
  );
}

/** What the agent wrote when its Build ended, or the question it stopped on. */
export function AgentSummary({ task, iteration }: { task: Task; iteration: LoopIteration }) {
  return (
    <div className={MARKDOWN_BOX}>
      {iteration.summary || iteration.blocked ? (
        <MarkdownBlock
          text={iteration.summary ?? iteration.blocked ?? ""}
          projectId={task.project_id}
        />
      ) : (
        <span className="text-muted-foreground">The agent wrote no summary.</span>
      )}
    </div>
  );
}

/**
 * The agent's own notes, `.maestro/loop/PROGRESS.md` in the loop's worktree: the loop's memory,
 * which every fresh session reads first and updates before it stops. `.maestro/` is excluded from
 * git, so they are never committed.
 */
export function NotesFile({ task, notes }: { task: Task; notes: string | null | undefined }) {
  return (
    <div className="overflow-hidden rounded-lg border border-foreground/7 bg-background/50">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-1.5 text-xs">
        <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono">.maestro/loop/PROGRESS.md</span>
        <span className="text-muted-foreground">written by the agent, never committed</span>
      </div>
      <div className="p-3 text-xs leading-relaxed [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h3]:font-semibold">
        {notes?.trim() ? (
          <MarkdownBlock text={notes} projectId={task.project_id} />
        ) : (
          <span className="text-muted-foreground">The agent left no notes.</span>
        )}
      </div>
    </div>
  );
}
