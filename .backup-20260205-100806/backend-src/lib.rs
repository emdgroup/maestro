pub mod db;
pub mod error;
pub mod models;
pub mod ipc;

pub use db::{init_db, AppState};
pub use error::AppError;
pub use models::{Project, Task, Worktree, ExecutionLog, AppSettings, ProjectStatus, TaskStatus, WorktreeStatus, ExecutionStatus};
pub use ipc::{get_projects, get_tasks, create_task, get_settings, save_settings};
