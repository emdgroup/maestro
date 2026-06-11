// Re-export from new domain modules for backwards compatibility
pub use crate::settings::models as settings;
pub use crate::project::models as project;
pub use crate::task::models as task;
pub use crate::connectivity::models as connection;
pub use crate::git::review_models as review;
pub use crate::git::diff_models as diff;
pub use crate::execution::models as worktree;
pub use crate::integration::issue_tracking_models as issue_tracking;
pub use crate::integration::integration_models as integration;
pub use crate::project::{Project, ProjectStatus, ProjectConfig, ProjectIssueTrackingConfig, ProjectState, SessionSnapshot, TaskSnapshot, WorktreeSnapshot, now_rfc3339};
pub use crate::task::{Task, TaskStatus, TaskPriority, TaskRelationship, TaskInstruction, TaskAttachment, CreateTaskRequest, ProjectConfigResponse, ProjectConfigRequest, TaskConfigRequest, TASK_SELECT};
pub use crate::connectivity::{GitConnection, ConnectionStatus};
pub use crate::execution::{Worktree, WorktreeWithStatus, AheadBehind, ActiveSessionInfo, ExecutionMode, SessionListEntryDto, PtySessionMeta, WORKTREE_DIR, WORKTREE_PATH_PREFIX, worktree_path_for_task};
pub use settings::{AppSettings, ActivityVisibility, EnterKeyBehavior, TerminalColorMode};
pub use crate::git::{ReviewFeedback, ReviewComment, ReviewDecision, SaveReviewRequest, ReviewResult, MergeResult, TaskReviewWithComments, ReviewCommentEntry, DiffTarget, WorktreeDiffResult, DirtyStatus, CommitInfo};
pub use crate::integration::{IssueTrackingConfig, RemoteIssue, IntegrationStatus, CredentialSource};
