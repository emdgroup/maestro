/**
 * Git Worktree Operations Module
 *
 * Provides promise-based git worktree lifecycle management using simple-git.
 * All operations follow safe git command ordering to prevent repository corruption.
 */
/**
 * Create git worktree in .worktree-pool/ directory
 *
 * @param repoPath - Path to main git repository
 * @param worktreeId - Unique worktree identifier (e.g., wt-001)
 * @param taskId - Task ID for branch naming (pool/agent-task-{taskId})
 * @returns Object with path and branch name
 * @throws Error if git worktree creation fails
 */
export declare function createWorktree(repoPath: string, worktreeId: string, taskId: number): Promise<{
    path: string;
    branch: string;
}>;
/**
 * Delete git worktree and associated branch
 *
 * CRITICAL: Follows safe deletion order:
 * 1. Remove worktree (git worktree remove)
 * 2. Delete branch (git branch -D)
 * 3. Prune metadata (git worktree prune)
 *
 * @param repoPath - Path to main git repository
 * @param worktreeId - Worktree identifier to delete
 * @param branchName - Branch name to delete
 * @throws Error if any deletion step fails
 */
export declare function deleteWorktree(repoPath: string, worktreeId: string, branchName: string): Promise<void>;
/**
 * Reset worktree to clean main branch state
 *
 * Useful for returning worktree to pool after task execution.
 * Discards all changes and untracked files.
 *
 * @param repoPath - Path to main git repository
 * @param worktreeId - Worktree identifier to reset
 * @throws Error if reset fails
 */
export declare function resetWorktree(repoPath: string, worktreeId: string): Promise<void>;
/**
 * Prune stale worktree metadata
 *
 * Cleans up .git/worktrees/ entries that no longer have valid working directories.
 * Should be run periodically to prevent metadata accumulation.
 *
 * @param repoPath - Path to main git repository
 * @throws Error if prune fails
 */
export declare function pruneWorktrees(repoPath: string): Promise<void>;
/**
 * Check if worktree exists and is usable
 *
 * Non-throwing health check for worktree validation.
 *
 * @param repoPath - Path to main git repository
 * @param worktreePath - Path to worktree to check
 * @returns true if worktree is healthy, false otherwise
 */
export declare function isWorktreeHealthy(repoPath: string, worktreePath: string): Promise<boolean>;
//# sourceMappingURL=git-manager.d.ts.map