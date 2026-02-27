use serde::{Deserialize, Serialize};
use specta::Type;

/// Outcome of a squash merge operation
/// Matches the TypeScript interface from sidecar/src/merge-manager.ts
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct MergeOutcome {
    /// Whether merge completed successfully
    pub success: bool,
    /// Conflict descriptions (empty if no conflicts)
    pub conflicts: Vec<String>,
    /// List of conflicted files (if any)
    #[serde(rename = "conflictFiles")]
    pub conflict_files: Option<Vec<String>>,
    /// SHA of the merge commit (only present on success)
    #[serde(rename = "mergeCommitSha")]
    pub merge_commit_sha: Option<String>,
    /// Human-readable message about merge result
    pub message: Option<String>,
}
