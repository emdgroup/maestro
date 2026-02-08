pub mod project;
pub mod task;
pub mod worktree;
pub mod execution_log;
pub mod settings;
pub mod sync;
pub mod review;
pub mod merge_outcome;
pub mod connection;

pub use project::{Project, ProjectStatus, SshConfig, SshAuthMethod};
pub use connection::GitConnection;
pub use task::{Task, TaskStatus, CreateTaskRequest, ProjectConfigResponse, ProjectConfigRequest, TaskConfigRequest};
pub use worktree::{Worktree, WorktreeStatus, PoolStatus};
pub use execution_log::{ExecutionLog, ExecutionStatus, ErrorEvent};
pub use settings::AppSettings;
pub use sync::{SyncResult, GitHubIssue, JiraIssue, JiraSearchResponse, JiraFields};
pub use review::{ReviewFeedback, ReviewComment, ReviewDecision, SaveReviewRequest};
pub use merge_outcome::MergeOutcome;
