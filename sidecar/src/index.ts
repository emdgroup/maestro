/**
 * Git Worktree Lifecycle Management for Tauri Sidecar
 *
 * This module provides promise-based git worktree operations for the GSD Agent Orchestrator.
 * Called from Rust IPC handlers via Tauri sidecar.
 *
 * Key constraints: Strict git operation ordering to prevent corruption.
 */

// Stub - will be implemented in git-manager.ts
export async function createWorktree(repoPath: string, worktreeId: string, taskId: number) {
  throw new Error("Not implemented");
}

export async function deleteWorktree(repoPath: string, worktreeId: string, branchName: string) {
  throw new Error("Not implemented");
}

export async function resetWorktree(repoPath: string, worktreeId: string) {
  throw new Error("Not implemented");
}

export async function pruneWorktrees(repoPath: string) {
  throw new Error("Not implemented");
}

export async function isWorktreeHealthy(repoPath: string, worktreePath: string): Promise<boolean> {
  return false;
}
