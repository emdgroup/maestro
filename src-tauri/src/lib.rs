pub mod db;
pub mod error;
pub mod models;
pub mod ipc;
pub mod process;
pub mod ssh;
pub mod git;
pub mod websocket;

pub use db::{init_db, AppState, get_git_connection};
pub use error::AppError;
pub use models::{Project, Task, Worktree, ExecutionLog, ErrorEvent, AppSettings, ProjectStatus, TaskStatus, WorktreeStatus, ExecutionStatus, SyncResult, ReviewFeedback, ReviewComment, ReviewDecision, ProjectConfigResponse, ProjectConfigRequest, TaskConfigRequest, GitConnection, ProjectConfig, ProjectState, TaskSnapshot, WorktreeSnapshot};
pub use process::{spawn_agent_cli, ProcessOutput, spawn_agent_cli_pty, PtySession};
pub use ipc::{get_projects, get_connection_projects, get_project, get_tasks, create_task, update_task, get_settings, save_settings, sync_github_issues, sync_jira_issues, save_import_config, get_project_settings, update_project_settings, update_task_settings};
