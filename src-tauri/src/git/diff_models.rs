use serde::{Deserialize, Serialize};
use specta::Type;

/// Controls what get_worktree_diff compares against.
///
/// - Head: `git diff HEAD` (uncommitted changes vs last commit)
/// - Branch: `git diff --unified=6 origin/{branch}..HEAD` (committed branch changes)
/// - Commit: `git diff --unified=6 {sha}..HEAD` (changes since a specific commit)
/// - BranchAll: `git diff --unified=6 origin/{branch}` (all changes including uncommitted)
/// - CommitRange: `git diff --unified=6 {from}..{to}` (single commit view)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type")]
#[specta(export)]
pub enum DiffTarget {
    Head,
    Branch { branch: String },
    Commit { sha: String },
    BranchAll { branch: String },
    CommitRange { from: String, to: String },
}

/// Return type for get_worktree_diff. Bundles the unified diff string with the
/// list of untracked files (not yet `git add`-ed) so both are fetched in one IPC call.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeDiffResult {
    pub diff: String,
    pub untracked_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DirtyStatus {
    pub modified_count: u32,
    pub untracked_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CommitInfo {
    pub sha: String,
    pub message: String,
    pub file_count: u32,
}
