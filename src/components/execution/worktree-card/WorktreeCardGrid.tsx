import { WorktreeCard } from "./WorktreeCard";
import { WorktreeCardGroup } from "./WorktreeCardGroup";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

interface WorktreeCardGridProps {
  viewMode: "grouped" | "grid";
  flatWorktrees: WorktreeWithStatus[];
  /** Every live session in the project; each card picks out the ones running in its own path. */
  sessions: ActiveSessionInfo[];
  /** One ticker for the whole grid, so the age labels advance together and cheaply. */
  now: number;
  groups: Array<{ groupKey: string; items: WorktreeWithStatus[] }>;
  collapsedGroups: Record<string, boolean>;
  onToggleGroup: (group: string) => void;
  onSelectWorktree: (path: string) => void;
  onDeleteWorktree: (path: string) => void;
  repoPath: string;
  emptyMessage?: string;
}

export function WorktreeCardGrid({
  viewMode,
  flatWorktrees,
  sessions,
  now,
  groups,
  collapsedGroups,
  onToggleGroup,
  onSelectWorktree,
  onDeleteWorktree,
  repoPath,
  emptyMessage,
}: WorktreeCardGridProps) {
  if (viewMode === "grid") {
    if (flatWorktrees.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-sm text-muted-foreground">
            {emptyMessage ?? "No worktrees yet"}
          </span>
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        <div className="flex flex-wrap gap-3">
          {flatWorktrees.map((wt) => (
            <WorktreeCard
              key={wt.path}
              worktree={wt}
              repoPath={repoPath}
              sessions={sessions}
              now={now}
              onSelect={onSelectWorktree}
              onDelete={onDeleteWorktree}
            />
          ))}
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-muted-foreground">{emptyMessage ?? "No worktrees yet"}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
      {groups.map((group) => (
        <WorktreeCardGroup
          key={group.groupKey}
          groupKey={group.groupKey}
          count={group.items.length}
          isCollapsed={collapsedGroups[group.groupKey] ?? false}
          onToggleCollapse={() => onToggleGroup(group.groupKey)}
        >
          {group.items.map((wt) => (
            <WorktreeCard
              key={wt.path}
              worktree={wt}
              repoPath={repoPath}
              sessions={sessions}
              now={now}
              onSelect={onSelectWorktree}
              onDelete={onDeleteWorktree}
            />
          ))}
        </WorktreeCardGroup>
      ))}
    </div>
  );
}
