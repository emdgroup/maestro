import { WorktreeCard } from "./WorktreeCard";
import { WorktreeCardGroup } from "./WorktreeCardGroup";
import type { WorktreeGroup } from "./worktree-usage";
import type { ActiveSessionInfo, WorktreeWithStatus } from "@/types/bindings";

interface WorktreeCardGridProps {
  /** Live sessions keyed by the worktree they run in. See `sessionsByWorktree`. */
  sessionsByPath: Map<string, ActiveSessionInfo[]>;
  /** One ticker for the whole grid, so the age labels advance together and cheaply. */
  now: number;
  /**
   * The repository checkout, which sits on its own row above the groups rather than in one. It is
   * not a worktree cut from a base branch and has nothing to be grouped with — see
   * `groupWorktrees`, which leaves it out. `null` when a filter hides it.
   */
  repository: WorktreeWithStatus | null;
  groups: WorktreeGroup[];
  collapsedGroups: Record<string, boolean>;
  onToggleGroup: (group: string) => void;
  onSelectWorktree: (path: string) => void;
  onDeleteWorktree: (path: string) => void;
  repoPath: string;
  projectId: number | null;
  /** Whether cards should look their own branch's pull request up. See `WorktreeCard`. */
  pullRequests?: boolean;
  emptyMessage?: string;
}

export function WorktreeCardGrid({
  sessionsByPath,
  now,
  repository,
  groups,
  collapsedGroups,
  onToggleGroup,
  onSelectWorktree,
  onDeleteWorktree,
  repoPath,
  projectId,
  pullRequests,
  emptyMessage,
}: WorktreeCardGridProps) {
  const card = (wt: WorktreeWithStatus) => (
    <WorktreeCard
      key={wt.path}
      worktree={wt}
      repoPath={repoPath}
      projectId={projectId}
      sessions={sessionsByPath.get(wt.path) ?? []}
      now={now}
      pullRequests={pullRequests}
      onSelect={onSelectWorktree}
      onDelete={onDeleteWorktree}
    />
  );

  if (!repository && groups.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-muted-foreground">{emptyMessage ?? "No worktrees yet"}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
      {/* No header and no chevron: a section of one, that is always the same one and can never
          gain a sibling, is a heading that says nothing. Sitting above the first group header is
          enough to set it apart. */}
      {repository && <div className="flex flex-wrap gap-3 px-2 pb-3">{card(repository)}</div>}

      {groups.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {emptyMessage ?? "No worktrees yet"}
        </div>
      ) : (
        groups.map((group) => (
          <WorktreeCardGroup
            key={group.groupKey}
            groupKey={group.groupKey}
            count={group.items.length}
            isCollapsed={collapsedGroups[group.groupKey] ?? false}
            onToggleCollapse={() => onToggleGroup(group.groupKey)}
          >
            {group.items.map(card)}
          </WorktreeCardGroup>
        ))
      )}
    </div>
  );
}
