import { formatDistanceToNow } from "date-fns";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib";
import type { WorktreeWithStatus } from "@/types/bindings";

function parseDiffStat(
  raw: string | null,
): { files: number; insertions: number; deletions: number } | null {
  if (!raw) return null;
  const filesMatch = raw.match(/(\d+) files? changed/);
  const insMatch = raw.match(/(\d+) insertions?\(\+\)/);
  const delMatch = raw.match(/(\d+) deletions?\(-\)/);
  if (!filesMatch && !insMatch && !delMatch) return null;
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

interface WorktreeCardProps {
  worktree: WorktreeWithStatus;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}

export function WorktreeCard({ worktree, onSelect, onDelete }: WorktreeCardProps) {
  const diffStat = parseDiffStat(worktree.diff_stat);
  const aheadBehind = worktree.ahead_behind;

  return (
    <div
      className={cn(
        "relative group rounded-lg border bg-card p-4 transition-colors w-56 shrink-0",
        worktree.git_status !== "" || worktree.diff_stat !== null
          ? "cursor-pointer hover:bg-muted/10"
          : "cursor-default",
      )}
      onClick={() => {
        if (worktree.id == null) return;
        if (worktree.git_status === "" && worktree.diff_stat === null) return;
        onSelect(worktree.id);
      }}
    >
      {/* Delete button — appears on hover */}
      <button
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          if (worktree.id != null) onDelete(worktree.id);
        }}
        aria-label="Delete worktree"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      {/* Branch name */}
      <div className="font-mono text-sm font-medium truncate pr-6">{worktree.branch_name}</div>

      {/* Stats row */}
      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
        {diffStat && (
          <>
            {diffStat.insertions > 0 && (
              <span className="text-success font-mono">+{diffStat.insertions}</span>
            )}
            {diffStat.deletions > 0 && (
              <span className="text-destructive font-mono">-{diffStat.deletions}</span>
            )}
            {diffStat.insertions === 0 && diffStat.deletions === 0 && (
              <span className="font-mono">+0 / -0</span>
            )}
          </>
        )}
        {worktree.created_at && (
          <span>{formatDistanceToNow(new Date(worktree.created_at), { addSuffix: true })}</span>
        )}
        {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
          <span className="font-mono">
            {aheadBehind.ahead > 0 && (
              <span className="text-success">↑{aheadBehind.ahead}</span>
            )}
            {aheadBehind.ahead > 0 && aheadBehind.behind > 0 && " "}
            {aheadBehind.behind > 0 && (
              <span className="text-warning">↓{aheadBehind.behind}</span>
            )}
          </span>
        )}
      </div>

      {/* Status badges */}
      {(worktree.is_zombie || worktree.is_orphan) && (
        <div className="flex items-center gap-1.5 mt-2">
          {worktree.is_zombie && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
              Zombie
            </span>
          )}
          {worktree.is_orphan && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              Orphan
            </span>
          )}
        </div>
      )}
    </div>
  );
}
