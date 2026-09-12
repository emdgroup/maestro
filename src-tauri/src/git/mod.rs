pub mod diff_models;
pub mod exec;
pub mod merge;
pub mod ops;
pub mod remote;
pub mod review;
pub mod review_handlers;
pub mod review_models;
pub mod worktree_handlers;
pub mod worktree_lifecycle;
pub mod worktree_query;
pub mod worktree_staging;
pub mod worktree_sync;

pub use diff_models::{
    BinaryFileInfo, CommitInfo, DiffTarget, DirtyStatus, WorktreeDiffResult, WorktreeDiffStats,
};
pub use review_models::{
    MergeResult, ReviewComment, ReviewCommentEntry, ReviewDecision, ReviewFeedback, ReviewResult,
    SaveReviewRequest, TaskReviewWithComments,
};

pub use exec::{run_git_commands_lossy, run_git_in_dir, run_git_in_dir_lossy};
pub use merge::squash_merge_to_base;
pub use ops::{
    create_pull_request_worktree, create_worktree, delete_worktree, forget_pull_request_refspec,
    get_current_branch, git_status, list_branches, list_worktrees, local_branch_for,
    parse_branch_list, parse_worktree_list, prune_remote_refs, pull_request_branch, push_branch,
    BranchList, ParsedWorktree,
};
pub use worktree_lifecycle::canonicalize_repo_path;
