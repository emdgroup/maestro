/**
 * Git Worktree Operations Module
 *
 * Provides promise-based git worktree lifecycle management using simple-git.
 * All operations follow safe git command ordering to prevent repository corruption.
 */
import { simpleGit } from "simple-git";
import path from "path";
/**
 * Create git worktree in .worktree-pool/ directory
 *
 * @param repoPath - Path to main git repository
 * @param worktreeId - Unique worktree identifier (e.g., wt-001)
 * @param taskId - Task ID for branch naming (pool/agent-task-{taskId})
 * @returns Object with path and branch name
 * @throws Error if git worktree creation fails
 */
export async function createWorktree(repoPath, worktreeId, taskId) {
    const git = simpleGit(repoPath);
    const worktreePath = path.join(repoPath, ".worktree-pool", worktreeId);
    const branchName = `pool/agent-task-${taskId}`;
    try {
        console.log(`Creating worktree: ${worktreePath} on branch ${branchName}`);
        // git worktree add <path> -b <branch> main
        await git.raw(["worktree", "add", worktreePath, "-b", branchName, "main"]);
        console.log(`✓ Worktree created: ${worktreeId}`);
        return { path: worktreePath, branch: branchName };
    }
    catch (error) {
        throw new Error(`Failed to create worktree ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
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
export async function deleteWorktree(repoPath, worktreeId, branchName) {
    const git = simpleGit(repoPath);
    const worktreePath = path.join(repoPath, ".worktree-pool", worktreeId);
    try {
        console.log(`Deleting worktree: ${worktreeId} (branch: ${branchName})`);
        // Step 1: Remove worktree (force flag handles dirty state)
        try {
            await git.raw(["worktree", "remove", worktreePath, "--force"]);
            console.log(`✓ Worktree removed: ${worktreeId}`);
        }
        catch (error) {
            throw new Error(`Failed to remove worktree ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Step 2: Delete branch (after worktree is removed)
        try {
            await git.branch(["-D", branchName]);
            console.log(`✓ Branch deleted: ${branchName}`);
        }
        catch (error) {
            throw new Error(`Failed to delete branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Step 3: Prune stale metadata
        try {
            await git.raw(["worktree", "prune"]);
            console.log(`✓ Worktree metadata pruned`);
        }
        catch (error) {
            // Non-fatal: log but don't throw
            console.warn(`Warning: Failed to prune worktree metadata: ${error}`);
        }
        console.log(`✓ Worktree cleanup complete: ${worktreeId}`);
    }
    catch (error) {
        // Re-throw with context
        throw error;
    }
}
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
export async function resetWorktree(repoPath, worktreeId) {
    const worktreePath = path.join(repoPath, ".worktree-pool", worktreeId);
    const git = simpleGit(worktreePath);
    try {
        console.log(`Resetting worktree: ${worktreeId}`);
        // Hard reset to main
        await git.raw(["reset", "--hard", "main"]);
        // Clean untracked files and directories
        await git.raw(["clean", "-fd"]);
        console.log(`✓ Worktree reset: ${worktreeId}`);
    }
    catch (error) {
        throw new Error(`Failed to reset worktree ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Prune stale worktree metadata
 *
 * Cleans up .git/worktrees/ entries that no longer have valid working directories.
 * Should be run periodically to prevent metadata accumulation.
 *
 * @param repoPath - Path to main git repository
 * @throws Error if prune fails
 */
export async function pruneWorktrees(repoPath) {
    const git = simpleGit(repoPath);
    try {
        console.log(`Pruning worktree metadata`);
        await git.raw(["worktree", "prune"]);
        console.log(`✓ Worktree metadata pruned`);
    }
    catch (error) {
        throw new Error(`Failed to prune worktrees: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Check if worktree exists and is usable
 *
 * Non-throwing health check for worktree validation.
 *
 * @param repoPath - Path to main git repository
 * @param worktreePath - Path to worktree to check
 * @returns true if worktree is healthy, false otherwise
 */
export async function isWorktreeHealthy(repoPath, worktreePath) {
    const git = simpleGit(repoPath);
    try {
        // List all worktrees and check if this path exists
        const result = await git.raw(["worktree", "list", "--porcelain"]);
        return result.includes(worktreePath);
    }
    catch (error) {
        console.warn(`Health check failed for ${worktreePath}: ${error}`);
        return false;
    }
}
//# sourceMappingURL=git-manager.js.map