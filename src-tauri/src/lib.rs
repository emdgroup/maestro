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
pub use ipc::*;

use tauri_specta::{collect_commands, Builder};

pub fn create_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::ipc::get_projects,
            crate::ipc::get_connection_projects,
            crate::ipc::create_project,
            crate::ipc::get_project,
            crate::ipc::remove_project,
            crate::ipc::get_tasks,
            crate::ipc::create_task,
            crate::ipc::update_task,
            crate::ipc::get_settings,
            crate::ipc::save_settings,
            crate::ipc::sync_github_issues,
            crate::ipc::sync_jira_issues,
            crate::ipc::save_import_config,
            crate::ipc::lease_worktree,
            crate::ipc::return_worktree,
            crate::ipc::get_pool_status,
            crate::ipc::cleanup_worktree,
            crate::ipc::recover_dirty_worktrees,
            crate::ipc::initialize_worktree_pool,
            crate::ipc::spawn_agent_execution,
            crate::ipc::get_execution_logs,
            crate::ipc::retry_execution,
            crate::ipc::cancel_execution,
            crate::ipc::attach_terminal,
            crate::ipc::send_terminal_input,
            crate::ipc::resize_terminal,
            crate::ipc::detach_terminal,
            crate::ipc::pause_agent_execution,
            crate::ipc::resume_agent_execution,
            crate::ipc::append_terminal_output,
            crate::ipc::get_diff_for_review,
            crate::ipc::save_task_review,
            crate::ipc::request_changes,
            crate::ipc::approve_task_and_merge,
            crate::ipc::get_project_settings,
            crate::ipc::update_project_settings,
            crate::ipc::update_task_settings,
            crate::ipc::get_ssh_connections,
            crate::ipc::get_ssh_connection,
            crate::ipc::get_ssh_connection_status,
            crate::ipc::save_ssh_connection,
            crate::ipc::connect_ssh_without_credentials,
            crate::ipc::connect_ssh_with_password,
            crate::ipc::connect_ssh_with_key,
            crate::ipc::list_remote_directories,
            crate::ipc::list_local_directories,
            crate::ipc::get_default_file_picker_path,
            crate::ipc::list_drives,
            crate::ipc::get_system_accent_color,
            crate::ipc::delete_ssh_connection,
            crate::ipc::forget_saved_password,
            crate::ipc::rename_ssh_connection
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use specta_typescript::Typescript;

    #[test]
    fn generate_typescript_bindings() {
        create_builder()
            .export(
                Typescript::default().header("// @ts-nocheck"),
                "../src/types/bindings.ts"
            )
            .expect("Failed to export TypeScript bindings");

        println!("✅ TypeScript bindings generated successfully");
    }
}