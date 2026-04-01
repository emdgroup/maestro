import { WorktreeCard } from "@/components/execution/WorktreeCard";
import { WorktreeCardGroup } from "@/components/execution/WorktreeCardGroup";
import type { WorktreeWithStatus } from "@/types/bindings";

interface WorktreeCardGridProps {
  groups: Array<{ groupKey: string; items: WorktreeWithStatus[] }>;
  collapsedGroups: Record<string, boolean>;
  onToggleGroup: (group: string) => void;
  onSelectWorktree: (id: number) => void;
  onDeleteWorktree: (id: number) => void;
  emptyMessage?: string;
}

export function WorktreeCardGrid({
  groups,
  collapsedGroups,
  onToggleGroup,
  onSelectWorktree,
  onDeleteWorktree,
  emptyMessage,
}: WorktreeCardGridProps) {
  if (groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-muted-foreground">{emptyMessage ?? "No worktrees yet"}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-2">
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
              onSelect={onSelectWorktree}
              onDelete={onDeleteWorktree}
            />
          ))}
        </WorktreeCardGroup>
      ))}
    </div>
  );
}
