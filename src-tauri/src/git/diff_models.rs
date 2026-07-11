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
///
/// When the diff or untracked list exceeds the server-side caps, the corresponding
/// `_truncated` flag is set to true and `total_*` reflects the actual uncapped size.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeDiffResult {
    pub diff: String,
    pub diff_truncated: bool,
    pub total_diff_bytes: usize,
    pub untracked_files: Vec<String>,
    pub untracked_truncated: bool,
    pub total_untracked: usize,
}

/// Lightweight summary returned by get_worktree_diff_stats — no unified diff text,
/// just the numbers needed for stats display in the session header.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeDiffStats {
    pub file_count: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub untracked_count: u32,
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
