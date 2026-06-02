pub mod project;
pub mod task;
pub mod worktree;
pub mod settings;
pub mod review;
pub mod connection;
pub mod diff;
pub mod issue_tracking;
pub mod integration;

pub use project::{Project, ProjectStatus, ProjectConfig, ProjectIssueTrackingConfig, ProjectState, TaskSnapshot, WorktreeSnapshot, now_rfc3339};
pub use connection::{GitConnection, ConnectionStatus};
pub use task::{Task, TaskStatus, TaskPriority, TaskRelationship, TaskInstruction, TaskAttachment, CreateTaskRequest, ProjectConfigResponse, ProjectConfigRequest, TaskConfigRequest, TASK_SELECT};
pub use worktree::{Worktree, WorktreeWithStatus, AheadBehind, ActiveSessionInfo, ExecutionMode, SessionListEntryDto, PtySessionMeta, WORKTREE_DIR, WORKTREE_PATH_PREFIX, worktree_path_for_task};
pub use settings::{AppSettings, ActivityVisibility, EnterKeyBehavior, TerminalColorMode};
pub use review::{ReviewFeedback, ReviewComment, ReviewDecision, SaveReviewRequest, ReviewResult, MergeResult};
pub use diff::{DiffTarget, WorktreeDiffResult};
pub use issue_tracking::{IssueTrackingConfig, RemoteIssue};
pub use integration::{IntegrationStatus, CredentialSource};
