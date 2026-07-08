import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import type { WorktreeWithStatus } from "@/types/bindings";
import type { PendingRestore } from "./useSessionHistory";

interface Props {
  pendingRestore: PendingRestore;
  repoPath: string;
  filteredWorktrees: WorktreeWithStatus[];
  worktreeFilter: string;
  onWorktreeFilterChange: (q: string) => void;
  showFilter: boolean;
  selectedWorktreePath: string;
  onSelectWorktreePath: (path: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  isPending: boolean;
}

export function WorktreePicker({
  pendingRestore,
  repoPath,
  filteredWorktrees,
  worktreeFilter,
  onWorktreeFilterChange,
  showFilter,
  selectedWorktreePath,
  onSelectWorktreePath,
  onCommit,
  onCancel,
  isPending,
}: Props) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm rounded-xl"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-lg border border-border bg-card shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pt-3 pb-2 border-b border-border">
          <p className="text-xs font-semibold">Choose Worktree</p>
          {pendingRestore.title && (
            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
              {pendingRestore.title}
            </p>
          )}
        </div>
        {showFilter && (
          <div className="px-2 py-1.5 border-b border-border">
            <input
              type="text"
              value={worktreeFilter}
              onChange={(e) => onWorktreeFilterChange(e.target.value)}
              placeholder="Filter worktrees…"
              className="w-full h-6 bg-muted/30 border border-border rounded px-2 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-ring"
              autoFocus
            />
          </div>
        )}
        <ScrollArea className="max-h-60">
          {filteredWorktrees.map((wt) => {
            const isMain = wt.path === repoPath;
            const isSelected = selectedWorktreePath === wt.path;
            return (
              <Button
                key={wt.path}
                variant="ghost"
                onClick={() => onSelectWorktreePath(wt.path)}
                className={cn(
                  "w-full text-left px-3 py-2 h-auto flex items-center gap-2.5 justify-start rounded-none",
                  isSelected ? "bg-primary/10" : "hover:bg-muted/20",
                )}
              >
                <span
                  className={cn(
                    "w-3 h-3 rounded-full border-2 shrink-0",
                    isSelected
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40 bg-transparent",
                  )}
                />
                <span className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate block">{wt.branch_name}</span>
                  <span className="text-[10px] text-muted-foreground/60 truncate block font-mono">
                    {wt.path}
                  </span>
                </span>
                {isMain && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold shrink-0">
                    default
                  </span>
                )}
              </Button>
            );
          })}
          {filteredWorktrees.length === 0 && (
            <div className="text-xs text-muted-foreground py-4 text-center">No worktrees match</div>
          )}
        </ScrollArea>
        <div className="px-3 py-2 border-t border-border flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            disabled={isPending}
            onClick={onCommit}
          >
            Restore
          </Button>
        </div>
      </div>
    </div>
  );
}
