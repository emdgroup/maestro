pub mod db;
pub mod error;
pub mod models;
pub mod ipc;
pub mod process;

pub use db::{init_db, AppState};
pub use error::AppError;
pub use models::{Project, Task, Worktree, ExecutionLog, AppSettings, ProjectStatus, TaskStatus, WorktreeStatus, ExecutionStatus, SyncResult};
pub use process::{spawn_agent_cli, ProcessOutput, spawn_agent_cli_pty, PtySession};
pub use ipc::{get_projects, get_or_create_project, get_tasks, create_task, update_task, get_settings, save_settings, sync_github_issues, sync_jira_issues, save_import_config};
