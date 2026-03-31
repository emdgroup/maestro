use serde::{Deserialize, Serialize};
use specta::Type;

/// Controls what get_worktree_diff compares against.
///
/// - Head: `git diff HEAD` (uncommitted changes vs last commit)
/// - Branch(name): `git diff --unified=6 origin/{name}..HEAD` (all branch changes)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "branch")]
#[specta(export)]
pub enum DiffTarget {
    Head,
    Branch(String),
}
