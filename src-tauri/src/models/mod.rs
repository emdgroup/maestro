// Re-export from new domain modules for backwards compatibility
pub use crate::connectivity::models as connection;
pub use crate::connectivity::{ConnectionStatus, GitConnection};
pub use crate::execution::models as worktree;
pub use crate::execution::{
    is_maestro_created_worktree, worktree_path_for_session, worktree_path_for_task,
    ActiveSessionInfo, AheadBehind, ExecutionMode, PtySessionMeta, SessionListEntryDto,
    SessionListResult, Worktree, WorktreeWithStatus, WORKTREE_DIR, WORKTREE_PATH_PREFIX,
    WORKTREE_SESSION_PATH_PREFIX,
};
pub use crate::git::diff_models as diff;
pub use crate::git::review_models as review;
pub use crate::git::{
    BinaryFileInfo, CommitInfo, DiffTarget, DirtyStatus, MergeResult, ReviewComment,
    ReviewCommentEntry, ReviewDecision, ReviewFeedback, ReviewResult, SaveReviewRequest,
    TaskReviewWithComments, WorktreeDiffResult, WorktreeDiffStats,
};
pub use crate::integration::integration_models as integration;
pub use crate::integration::issue_tracking_models as issue_tracking;
pub use crate::integration::{
    CredentialSource, IntegrationStatus, IssueTrackingConfig, RemoteIssue,
};
pub use crate::project::models as project;
pub use crate::project::{
    now_rfc3339, Project, ProjectConfig, ProjectIssueTrackingConfig, ProjectState, ProjectStatus,
    SessionSnapshot, TaskSnapshot, WorktreeSnapshot,
};
pub use crate::settings::models as settings;
pub use crate::task::models as task;
pub use crate::task::{
    BranchMode, CreateTaskRequest, PhaseStatus, ProjectConfigRequest, ProjectConfigResponse,
    PullRequestCi, Task, TaskAttachment, TaskBall, TaskComment, TaskCompletion, TaskConfigRequest,
    TaskInstruction, TaskPhase, TaskPriority, TaskRelationship, TaskStatus, WorkspaceMode,
    TASK_SELECT,
};
pub use settings::{
    ActivityVisibility, AgentStreamWidth, AppSettings, ConnectionCapacitySettings,
    EnterKeyBehavior, NewProjectColor, TerminalColorMode,
};
