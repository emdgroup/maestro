pub mod exec;
pub mod ops;
pub mod merge;
pub mod remote;
pub mod worktree_handlers;
pub mod review_handlers;
pub mod review_models;
pub mod diff_models;
pub mod worktree_query;
pub mod worktree_lifecycle;
pub mod worktree_staging;
pub mod review;

pub use review_models::{ReviewFeedback, ReviewComment, ReviewDecision, SaveReviewRequest, ReviewResult, MergeResult, TaskReviewWithComments, ReviewCommentEntry};
pub use diff_models::{DiffTarget, WorktreeDiffResult, DirtyStatus, CommitInfo};

pub use exec::{run_git_in_dir, run_git_in_dir_lossy, run_git_in_dir_with_stdin};
pub use ops::{
    BranchList, ParsedWorktree,
    create_worktree, delete_worktree, git_diff, git_status,
    list_branches, get_current_branch, list_worktrees,
    list_worktrees_local, parse_worktree_list, get_worktree_status_local, parse_branch_list,
};
pub use merge::squash_merge_to_base;
