import { useState, useEffect } from "react";
import { WorktreeManager, STATUS_FILTERS } from "@/components/execution/WorktreeManager";
import type { StatusFilter } from "@/components/execution/WorktreeManager";
import { usePendingWorktreeId, useNavigationActions } from "@/store/navigationStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";

interface WorktreesViewProps {
  projectId?: number;
  repoPath?: string;
}

/**
 * WorktreesView - Page-level orchestrator for the worktree management screen.
 * Owns the worktree data query and filter state, passes props down to WorktreeManager.
 * Handles deep-link selection via pendingWorktreeId from navigationStore.
 */
export const WorktreesView: React.FC<WorktreesViewProps> = ({ projectId, repoPath }) => {
  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  // Deep-link: pendingWorktreeId overrides selection on first mount
  useEffect(() => {
    if (pendingWorktreeId && worktrees.length > 0) {
      const match = worktrees.find((w) => String(w.id) === pendingWorktreeId);
      if (match && match.id != null) {
        setSelectedWorktreeId(match.id);
        clearPendingWorktree();
      }
    }
  }, [worktrees, pendingWorktreeId, clearPendingWorktree]);

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="Search branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-48 text-sm"
          />
          <ToggleGroup variant="outline" size="sm" defaultValue={["All"]}>
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem
                key={f}
                value={f}
                pressed={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className="text-xs px-3"
              >
                {f}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-2" />
      </div>

      {/* Worktree manager */}
      <div className="flex-1 min-h-0">
        <WorktreeManager
          worktrees={worktrees}
          selectedWorktreeId={selectedWorktreeId}
          onSelect={setSelectedWorktreeId}
          repoPath={repoPath ?? ""}
          projectId={projectId ?? 0}
          search={search}
          statusFilter={statusFilter}
        />
      </div>
    </div>
  );
};
