import { Clock, GitCommitVertical } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { parseDiffStat } from "@/lib/diff-utils";
import type { WorktreeWithStatus } from "@/types/bindings";
import { relativeAge } from "./worktree-usage";

interface WorktreeMetricsProps {
  worktree: WorktreeWithStatus;
  /** Passed in rather than read here, so one ticker drives every row. See `useNow`. */
  now: number;
  className?: string;
  /**
   * Replaces the ahead/behind segment with something interactive — `WorktreeSyncActions` in the
   * Worktrees view, which turns the two counts into push and pull.
   *
   * Optional because the workspace picker shares this component and has no business acting on a
   * remote. Left out, every metric below behaves exactly as it did before this existed.
   */
  sync?: React.ReactNode;
}

/**
 * How much work is in a worktree, how recently it moved, and how much of it has reached the remote.
 *
 * Every metric is dropped when it has nothing to say, so a quiet worktree renders a short row
 * rather than a row of zeroes and the words that would be needed to explain them. Returns nothing
 * at all when none of them apply, which is the normal state for a worktree just created.
 *
 * Shared by the grid card in the Worktrees view and the workspace picker, so the same worktree
 * reads the same way wherever it is shown.
 */
export function WorktreeMetrics({ worktree, now, className, sync }: WorktreeMetricsProps) {
  const diffStat = parseDiffStat(worktree.diff_stat);
  const aheadBehind = worktree.ahead_behind;
  const age = relativeAge(worktree.last_activity_at, now);

  const metrics: React.ReactNode[] = [];
  const push = (node: React.ReactNode) => metrics.push(node);
  if (age) {
    push(
      <span key="age" className="flex items-center gap-1 text-muted-foreground">
        <Clock className="size-3" />
        {age}
      </span>,
    );
  }
  if (diffStat && (diffStat.insertions > 0 || diffStat.deletions > 0)) {
    push(
      <span key="diff" className="flex items-center gap-1.5 font-mono">
        {diffStat.insertions > 0 && <span className="text-success">+{diffStat.insertions}</span>}
        {diffStat.deletions > 0 && <span className="text-destructive">−{diffStat.deletions}</span>}
      </span>,
    );
  }
  if (worktree.commit_count != null && worktree.commit_count > 0) {
    push(
      <span key="commits" className="flex items-center gap-0.5 font-mono">
        <GitCommitVertical className="size-3.5" />
        {worktree.commit_count}
      </span>,
    );
  }
  // Unconditional when interactive: the chips carry the counts themselves and still need somewhere
  // to render at zero, which is the fully-synced worktree whose only remaining action is a fetch.
  // The controls carry the same counts this branch would have rendered, so there is nothing to
  // fall through to: the card passes `sync` only when at least one of them has commits to move.
  if (sync) {
    push(
      <span key="remote" className="flex items-center gap-1">
        {sync}
      </span>,
    );
  } else if (aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0)) {
    push(
      <span key="remote" className="flex items-center gap-1.5 font-mono">
        {aheadBehind.ahead > 0 && <span className="text-success">↑{aheadBehind.ahead}</span>}
        {aheadBehind.behind > 0 && <span className="text-warning">↓{aheadBehind.behind}</span>}
      </span>,
    );
  }

  if (metrics.length === 0) return null;

  return (
    <span className={cn("flex items-center gap-2 text-xs flex-wrap", className)}>
      {metrics.map((metric, index) => (
        <span key={index} className="flex items-center gap-2">
          {index > 0 && <span className="text-muted-foreground/40">·</span>}
          {metric}
        </span>
      ))}
    </span>
  );
}
