import { useEffect } from "react";
import { WorktreeManager } from "@/components/execution/WorktreeManager";
import { usePendingWorktreeId, useNavigationActions } from "@/store/navigationStore";

interface WorktreeInfo {
  id: number;
  branch: string;
  isClean: boolean;
  lastCommit?: string;
  author?: string;
  timestamp?: string;
}

interface WorktreesViewProps {
  projectId?: number;
  worktrees?: WorktreeInfo[];
  onWorktreeClick?: (worktreeId: number) => void;
}

/**
 * WorktreesView - Page-level orchestrator for the worktree management screen
 * Displays git worktree instances with branch information and status
 */
export const WorktreesView: React.FC<WorktreesViewProps> = ({
  projectId,
  worktrees = [],
  onWorktreeClick,
}) => {
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();

  // When a pending worktree ID is set by navigate(), pass it as the highlighted worktree
  const highlightedWorktreeId = pendingWorktreeId ? Number(pendingWorktreeId) : null;

  useEffect(() => {
    if (pendingWorktreeId) {
      clearPendingWorktree();
    }
  }, [pendingWorktreeId, clearPendingWorktree]);

  // Simulate selection by triggering onWorktreeClick when highlighted worktree is set
  useEffect(() => {
    if (highlightedWorktreeId && onWorktreeClick) {
      onWorktreeClick(highlightedWorktreeId);
    }
  }, [highlightedWorktreeId, onWorktreeClick]);

  return (
    <WorktreeManager
      projectId={projectId}
      worktrees={worktrees}
      onWorktreeClick={onWorktreeClick}
    />
  );
};
