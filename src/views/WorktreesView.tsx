import { WorktreeManager } from "@/components/WorktreeManager";

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
  return (
    <WorktreeManager
      projectId={projectId}
      worktrees={worktrees}
      onWorktreeClick={onWorktreeClick}
    />
  );
};
