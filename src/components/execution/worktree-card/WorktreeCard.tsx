import { Bot, FolderRoot, SquareCheckBig, Terminal, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import { useNavigate } from "@/store/navigationStore";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";
import { WorktreeMetrics } from "./WorktreeMetrics";
import { hasSyncActions, WorktreeSyncActions } from "./WorktreeSyncActions";
import {
  agentLabel,
  isInUse,
  relativeWorktreePath,
  worktreeTitle,
  worktreeUsage,
} from "./worktree-usage";

interface WorktreeCardProps {
  worktree: WorktreeWithStatus;
  repoPath: string;
  /** The project the card belongs to, for the push/pull controls. Null disables them. */
  projectId: number | null;
  /** The live sessions running in this worktree, already scoped by `sessionsByWorktree`. */
  sessions: ActiveSessionInfo[];
  /** Passed in rather than read per card, so one ticker drives the whole grid. */
  now: number;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}

/**
 * A worktree in the grid. Opening one shows its diff.
 */
export function WorktreeCard({
  worktree,
  repoPath,
  projectId,
  sessions,
  now,
  onSelect,
  onDelete,
}: WorktreeCardProps) {
  const navigate = useNavigate();
  const isMain = worktree.path === repoPath;
  const usage = worktreeUsage(worktree, sessions);
  const inUse = isInUse(usage);
  const title = worktreeTitle(worktree);
  const location = relativeWorktreePath(worktree.path, repoPath);

  const card = (
    <div className="relative group rounded-lg border bg-card w-72 shrink-0 overflow-hidden transition-colors cursor-pointer hover:border-ring/50">
      <div className="p-3" onClick={() => onSelect(worktree.path)}>
        <div className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-medium truncate">{title}</span>
          </span>
          {isMain ? (
            // Labelled because this icon is the only thing distinguishing the repository checkout
            // from the worktrees it sits beside, and it is the one card with no delete button.
            <FolderRoot
              role="img"
              aria-label="Repository"
              className="size-3.5 shrink-0 text-accent"
            />
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mt-0.5 -mr-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(worktree.path);
              }}
              aria-label="Delete worktree"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>

        {/* A detached worktree keeps the branch name in the database for branch operations, but
              showing it here would claim a branch that is not checked out. */}
        <div
          className={cn(
            "mt-0.5 font-mono text-xs truncate",
            worktree.detached_at ? "text-warning" : "text-muted-foreground",
          )}
        >
          {worktree.detached_at ? `detached at ${worktree.detached_at}` : worktree.branch_name}
        </div>

        <WorktreeMetrics
          worktree={worktree}
          now={now}
          className="mt-2"
          sync={
            projectId != null && hasSyncActions(worktree) ? (
              <WorktreeSyncActions worktree={worktree} projectId={projectId} inUse={inUse} />
            ) : undefined
          }
        />
      </div>

      {inUse && (
        <Popover>
          <PopoverTrigger
            aria-label="Show what uses this worktree"
            className="w-full flex items-center gap-3 border-t bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
          >
            {usage.task && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <SquareCheckBig className="size-3.5" />1
              </span>
            )}
            {usage.agents.length > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Bot className="size-3.5" />
                {usage.agents.length}
              </span>
            )}
            {usage.shellCount > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Terminal className="size-3.5" />
                {usage.shellCount}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <div className="px-2 py-1.5 text-[10px] tracking-wide text-muted-foreground">
              USED BY
            </div>
            {usage.task && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-muted"
                onClick={() => navigate({ taskId: usage.task!.id })}
              >
                <SquareCheckBig className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{usage.task.name}</span>
              </button>
            )}
            {usage.agents.map((session) => (
              <button
                key={session.session_key}
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-muted"
                onClick={() => navigate({ sessionKey: session.session_key })}
              >
                <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{agentLabel(session)}</span>
              </button>
            ))}
            {usage.shellCount > 0 && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Terminal className="size-3.5 shrink-0" />
                <span>
                  {usage.shellCount} shell{usage.shellCount === 1 ? "" : "s"} running here
                </span>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={card} />
      <TooltipContent className="font-mono">{location}</TooltipContent>
    </Tooltip>
  );
}
