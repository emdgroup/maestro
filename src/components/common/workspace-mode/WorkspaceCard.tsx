import { cn } from "@/lib/utils";
import { WorktreeMetrics } from "@/components/execution/worktree-card/WorktreeMetrics";
import { worktreeTitle } from "@/components/execution/worktree-card/worktree-usage";
import type { WorktreeWithStatus } from "@/types/bindings";

interface WorkspaceCardProps {
  worktree: WorktreeWithStatus;
  /** Passed in rather than read here, so one ticker drives the whole list. See `useNow`. */
  now: number;
  /** The task that already owns this workspace, when that makes it unavailable. */
  takenBy?: string | null;
  /** The trigger has one line to work with, so it drops the metrics. */
  compact?: boolean;
}

/**
 * One workspace, as the dropdown shows it — the same shape the Worktrees view card uses, minus
 * the parts that only make sense there (deleting it, opening its diff, the sessions running in it).
 *
 * Spans rather than divs throughout: this renders inside a `SelectItem`, whose text slot is inline.
 */
export function WorkspaceCard({
  worktree,
  now,
  takenBy = null,
  compact = false,
}: WorkspaceCardProps) {
  const title = worktreeTitle(worktree);

  return (
    <span className="flex flex-col gap-0.5 min-w-0 flex-1">
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-sm truncate">{title}</span>
        {takenBy && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium truncate max-w-32">
            In use by {takenBy}
          </span>
        )}
      </span>

      {/* A detached worktree keeps its branch name in the database for branch operations, but
          showing it here would claim a branch that is not checked out. */}
      <span
        className={cn(
          "font-mono text-xs truncate",
          worktree.detached_at ? "text-warning" : "text-muted-foreground",
        )}
      >
        {worktree.detached_at ? `detached at ${worktree.detached_at}` : worktree.branch_name}
      </span>

      {!compact && <WorktreeMetrics worktree={worktree} now={now} className="mt-0.5" />}
    </span>
  );
}
