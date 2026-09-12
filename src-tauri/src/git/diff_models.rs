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
    Commit {
        sha: String,
    },
    /// Everything this worktree has done since it diverged from `branch`.
    ///
    /// Resolved through `git merge-base`, and compared against the **working tree** rather than
    /// HEAD, so the result is the same whether or not the agent committed — which is the point.
    /// There was a second variant here (`Branch`) that used `origin/<branch>..HEAD`: it named the
    /// remote rather than the local branch, used two-dot semantics so commits the base gained
    /// after we branched showed up as reversed changes, and being a commit range could not see
    /// uncommitted work at all. Nothing ever constructed it.
    BranchAll {
        branch: String,
    },
    CommitRange {
        from: String,
        to: String,
    },
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

/// What can be said about a file git refuses to diff line by line.
///
/// The sizes are the two blobs' byte counts, which is the only thing resembling a `+`/`-` count a
/// binary change has. Either is zero where that side does not exist — an addition or a deletion.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BinaryFileInfo {
    pub old_size: u32,
    pub new_size: u32,
    /// The working-tree copy, base64-encoded, for showing an image rather than describing it.
    /// `None` when it was not asked for, cannot exist, or is past the binary read limit.
    pub preview: Option<String>,
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
    /// RFC 3339, from `%cI`. Committer rather than author date: rebase and cherry-pick preserve
    /// the author date, so an agent's rebased commit would otherwise read as days old.
    pub committed_at: String,
}
