use serde::{Deserialize, Serialize};
use specta::Type;

/// Controls what get_worktree_diff compares against.
///
/// - Head: `git diff HEAD` (uncommitted changes vs last commit)
/// - Branch(name): `git diff --unified=6 origin/{name}..HEAD` (all branch changes)
/// - Commit(sha): `git diff --unified=6 {sha}..HEAD` (changes since a specific commit)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "branch")]
#[specta(export)]
pub enum DiffTarget {
    Head,
    Branch(String),
    Commit(String),
}

/// Return type for get_worktree_diff. Bundles the unified diff string with the
/// list of untracked files (not yet `git add`-ed) so both are fetched in one IPC call.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeDiffResult {
    pub diff: String,
    pub untracked_files: Vec<String>,
}
