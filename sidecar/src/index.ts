/**
 * Git Worktree Lifecycle Management for Tauri Sidecar
 *
 * This module provides promise-based git worktree operations for the GSD Agent Orchestrator.
 * Called from Rust IPC handlers via Tauri sidecar.
 *
 * Key constraints: Strict git operation ordering to prevent corruption.
 */

import * as gitManager from "./git-manager.js";
import * as mergeManager from "./merge-manager.js";

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
export async function createWorktree(
  repoPath: string,
  worktreeId: string,
  taskId: number
): Promise<{ path: string; branch: string }> {
  return gitManager.createWorktree(repoPath, worktreeId, taskId);
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
 * @example
 * await deleteWorktree('/path/to/repo', 'wt-001', 'pool/agent-task-42');
 */
export async function deleteWorktree(
  repoPath: string,
  worktreeId: string,
  branchName: string
): Promise<void> {
  return gitManager.deleteWorktree(repoPath, worktreeId, branchName);
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
 * @example
 * await resetWorktree('/path/to/repo', 'wt-001');
 */
export async function resetWorktree(
  repoPath: string,
  worktreeId: string
): Promise<void> {
  return gitManager.resetWorktree(repoPath, worktreeId);
}

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
export async function pruneWorktrees(repoPath: string): Promise<void> {
  return gitManager.pruneWorktrees(repoPath);
}

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
export async function isWorktreeHealthy(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  return gitManager.isWorktreeHealthy(repoPath, worktreePath);
}

/**
 * Get unified diff between two branches
 *
 * @param repoPath - Path to git repository
 * @param fromBranch - Source branch
 * @param toBranch - Target branch
 * @param contextLines - Number of context lines
 * @returns Raw unified diff string
 */
export async function getDiffBetweenBranches(
  repoPath: string,
  fromBranch: string,
  toBranch: string,
  contextLines: number = 6
): Promise<string> {
  return mergeManager.getDiffBetweenBranches(repoPath, fromBranch, toBranch, contextLines);
}

/**
 * Attempt squash merge of branch to main with task context
 *
 * @param repoPath - Path to git repository
 * @param taskId - Task ID for commit message
 * @param taskBranchName - Branch name to merge
 * @param taskName - Task name for commit message
 * @returns MergeOutcome with success flag and conflict details
 */
export async function squashMergeToMain(
  repoPath: string,
  taskId: number,
  taskBranchName: string,
  taskName: string
): Promise<mergeManager.MergeOutcome> {
  return mergeManager.squashMergeToMain(repoPath, taskId, taskBranchName, taskName);
}

/**
 * Abort a merge operation
 *
 * @param repoPath - Path to git repository
 * @returns true if abort succeeded, false otherwise
 */
export async function abortMergeOnConflict(repoPath: string): Promise<boolean> {
  return mergeManager.abortMergeOnConflict(repoPath);
}

// Export MergeOutcome type for Rust usage
export type { MergeOutcome } from "./merge-manager.js";

/**
 * CLI entry point for sidecar execution
 * Handles --get-diff and other command-line arguments
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--get-diff")) {
    // Parse: --get-diff <repoPath> <branchName> <targetBranch> <contextLines>
    const repoIndex = args.indexOf("--get-diff") + 1;
    const repoPath = args[repoIndex];
    const fromBranch = args[repoIndex + 1];
    const toBranch = args[repoIndex + 2];
    const contextLines = parseInt(args[repoIndex + 3] || "6", 10);

    if (!repoPath || !fromBranch || !toBranch) {
      console.error(
        "Usage: node index.js --get-diff <repoPath> <fromBranch> <toBranch> [contextLines]"
      );
      process.exit(1);
    }

    try {
      const diff = await getDiffBetweenBranches(repoPath, fromBranch, toBranch, contextLines);
      console.log(diff);
      process.exit(0);
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  } else if (args.includes("--merge")) {
    // Parse: --merge <repoPath> <taskId> <branchName> <taskName>
    const mergeIndex = args.indexOf("--merge") + 1;
    const repoPath = args[mergeIndex];
    const taskId = parseInt(args[mergeIndex + 1], 10);
    const branchName = args[mergeIndex + 2];
    const taskName = args[mergeIndex + 3];

    if (!repoPath || isNaN(taskId) || !branchName || !taskName) {
      console.error(
        "Usage: node index.js --merge <repoPath> <taskId> <branchName> <taskName>"
      );
      process.exit(1);
    }

    try {
      const outcome = await squashMergeToMain(
        repoPath,
        taskId,
        branchName,
        taskName
      );
      console.log(JSON.stringify(outcome));
      process.exit(0);
    } catch (error) {
      console.error(
        "Merge failed:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  } else if (args.includes("--delete-worktree")) {
    // Parse: --delete-worktree <repoPath> <worktreePath> <branchName>
    const deleteIndex = args.indexOf("--delete-worktree") + 1;
    const repoPath = args[deleteIndex];
    const worktreePath = args[deleteIndex + 1];
    const branchName = args[deleteIndex + 2];

    if (!repoPath || !worktreePath || !branchName) {
      console.error(
        "Usage: node index.js --delete-worktree <repoPath> <worktreePath> <branchName>"
      );
      process.exit(1);
    }

    try {
      await deleteWorktree(repoPath, worktreePath.split("/").pop() || "", branchName);
      console.log(JSON.stringify({ success: true, worktreeId: worktreePath.split("/").pop() }));
      process.exit(0);
    } catch (error) {
      console.error(
        "Cleanup failed:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  } else if (args.includes("--task-id")) {
    // Original task execution mode (for agent execution)
    console.log("Task execution mode not yet implemented in index.ts");
    process.exit(1);
  } else {
    // No recognized arguments
    console.log("GSD Sidecar - git worktree and merge operations");
    console.log("Usage:");
    console.log("  --get-diff <repoPath> <fromBranch> <toBranch> [contextLines]");
    console.log("  --merge <repoPath> <taskId> <branchName> <taskName>");
    console.log("  --delete-worktree <repoPath> <worktreePath> <branchName>");
    console.log("  --task-id <taskId>  (agent execution)");
    process.exit(0);
  }
}

// Run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
