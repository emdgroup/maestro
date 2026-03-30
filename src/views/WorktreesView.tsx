import { useState, useEffect } from "react";
import { WorktreeManager } from "@/components/execution/WorktreeManager";
import { usePendingWorktreeId, useNavigationActions } from "@/store/navigationStore";
import { useWorktreesQuery } from "@/services/worktree.service";

interface WorktreesViewProps {
  projectId?: number;
  repoPath?: string;
}

/**
 * WorktreesView - Page-level orchestrator for the worktree management screen.
 * Owns the worktree data query and passes props down to WorktreeManager.
 * Handles deep-link selection via pendingWorktreeId from navigationStore.
 */
export const WorktreesView: React.FC<WorktreesViewProps> = ({ projectId, repoPath }) => {
  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<number | null>(null);

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
    <WorktreeManager
      worktrees={worktrees}
      selectedWorktreeId={selectedWorktreeId}
      onSelect={setSelectedWorktreeId}
      repoPath={repoPath ?? ""}
      projectId={projectId ?? 0}
    />
  );
};
