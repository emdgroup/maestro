/**
 * Git Worktree Lifecycle Management for Tauri Sidecar
 *
 * This module provides promise-based git worktree operations for the GSD Agent Orchestrator.
 * Called from Rust IPC handlers via Tauri sidecar.
 *
 * Key constraints: Strict git operation ordering to prevent corruption.
 */
/**
 * Create git worktree in .worktree-pool/ directory
 *
 * @param repoPath - Path to main git repository
 * @param worktreeId - Unique worktree identifier (e.g., wt-001)
 * @param taskId - Task ID for branch naming (pool/agent-task-{taskId})
 * @returns Object with path and branch name
 * @throws Error with "Failed to create worktree" message on git failure
 * @example
 * const wt = await createWorktree('/path/to/repo', 'wt-001', 42);
 * console.log(wt.path); // .worktree-pool/wt-001
 * console.log(wt.branch); // pool/agent-task-42
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
 * @example
 * await deleteWorktree('/path/to/repo', 'wt-001', 'pool/agent-task-42');
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
 * @example
 * await resetWorktree('/path/to/repo', 'wt-001');
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
 * @example
 * await pruneWorktrees('/path/to/repo');
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
 * @example
 * const healthy = await isWorktreeHealthy('/path/to/repo', '/path/to/repo/.worktree-pool/wt-001');
 * if (!healthy) {
 *   console.log('Worktree needs recovery');
 * }
 */
export declare function isWorktreeHealthy(repoPath: string, worktreePath: string): Promise<boolean>;
//# sourceMappingURL=index.d.ts.map