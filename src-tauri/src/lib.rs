pub mod command_ext;
pub mod core;
pub mod error;
pub mod models;
pub mod ipc;
pub mod process;
pub mod ssh;
pub mod git;
pub mod streaming;
pub mod acp;
pub mod project_lock;
pub mod issue_tracking;
pub mod wsl;

pub use core::{init_db, AppState, SshState, AcpState, PtyState, get_git_connection, get_project_with_git_conn};
pub use models::{Project, Task, Worktree, AppSettings, ProjectStatus, TaskStatus, TaskPriority, TaskRelationship, TaskInstruction, TaskAttachment, WorktreeWithStatus, ActiveSessionInfo, SessionListEntryDto, ReviewFeedback, ReviewComment, ReviewDecision, ProjectConfigResponse, ProjectConfigRequest, TaskConfigRequest, GitConnection, ProjectConfig, ProjectState, TaskSnapshot, WorktreeSnapshot, IssueTrackingConfig, RemoteIssue, IntegrationStatus, CredentialSource, WORKTREE_DIR, WORKTREE_PATH_PREFIX, worktree_path_for_task};
pub use process::{ProcessOutput, spawn_agent_cli_pty, PtySession};
// IPC command functions are accessed via crate::ipc:: prefix in create_builder()
// No glob re-export needed; ssh_handlers uses super::project_handlers for internal imports

use tauri_specta::{collect_commands, Builder};

pub fn create_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::ipc::get_projects,
            crate::ipc::get_connection_projects,
            crate::ipc::create_project,
            crate::ipc::get_project,
            crate::ipc::open_project,
            crate::ipc::release_active_project_lock,
            crate::ipc::check_project_locks,
            crate::ipc::delete_project,
            crate::ipc::git_init_project,
            crate::ipc::check_is_git_repo,
            crate::ipc::clone_project,
            crate::ipc::create_new_project,
            crate::ipc::get_tasks,
            crate::ipc::create_task,
            crate::ipc::update_task,
            crate::ipc::archive_task,
            crate::ipc::delete_task,
            crate::ipc::list_task_relationships,
            crate::ipc::add_task_relationship,
            crate::ipc::delete_task_relationship,
            crate::ipc::list_task_instructions,
            crate::ipc::add_task_instruction,
            crate::ipc::list_project_branches,
            crate::ipc::get_settings,
            crate::ipc::save_settings,
            crate::ipc::list_worktrees_with_status,
            crate::ipc::get_worktree_diff,
            crate::ipc::create_worktree,
            crate::ipc::delete_worktree,
            crate::ipc::cleanup_zombie_worktrees,
            crate::ipc::spawn_interactive_execution,
            crate::ipc::drain_ready_queue,
            crate::ipc::attach_terminal,
            crate::ipc::send_terminal_input,
            crate::ipc::resize_terminal,
            crate::ipc::detach_terminal,
            crate::ipc::close_pty_session,
            crate::ipc::get_diff_for_review,
            crate::ipc::save_task_review,
            crate::ipc::request_changes,
            crate::ipc::approve_task_and_merge,
            crate::ipc::reject_review,
            crate::ipc::get_project_settings,
            crate::ipc::update_project_settings,
            crate::ipc::prime_project_server,
            crate::ipc::update_task_settings,
            crate::ipc::list_ssh_connections,
            crate::ipc::get_ssh_connection,
            crate::ipc::get_ssh_connection_status,
            crate::ipc::create_ssh_connection,
            crate::ipc::connect_ssh_without_credentials,
            crate::ipc::connect_ssh_with_password,
            crate::ipc::connect_ssh_with_agent,
            crate::ipc::connect_ssh_with_key,
            crate::ipc::list_remote_directories,
            crate::ipc::list_local_directories,
            crate::ipc::get_default_file_picker_path,
            crate::ipc::list_drives,
            crate::ipc::get_system_accent_color,
            crate::ipc::delete_ssh_connection,
            crate::ipc::forget_saved_password,
            crate::ipc::rename_ssh_connection,
            crate::ipc::stage_worktree_files,
            crate::ipc::commit_worktree,
            crate::ipc::discard_worktree_changes,
            crate::ipc::shelve_worktree_changes,
            crate::ipc::delete_untracked_files,
            crate::ipc::get_untracked_file_content,
            // ACP session management + unified agent discovery
            crate::ipc::spawn_acp_session,
            crate::ipc::send_acp_prompt,
            crate::ipc::send_acp_prompt_structured,
            crate::ipc::respond_acp_permission,
            crate::ipc::respond_acp_elicitation,
            crate::ipc::cancel_acp_session,
            crate::ipc::interrupt_acp_turn,
            crate::ipc::preflight_connection,
            crate::ipc::detect_project_agents,
            crate::ipc::discover_agents,
            crate::ipc::set_acp_model,
            crate::ipc::set_acp_mode,
            crate::ipc::set_acp_config_option,
            crate::ipc::search_session_files,
            crate::ipc::read_session_file,
            crate::ipc::read_session_file_binary,
            crate::ipc::get_acp_session_meta,
            crate::ipc::get_active_sessions,
            crate::ipc::list_acp_sessions,
            crate::ipc::load_acp_session,
            crate::ipc::drain_acp_replay,
            crate::ipc::prepare_external_attachments,
            crate::ipc::save_clipboard_image,
            crate::ipc::close_acp_session,
            crate::ipc::rename_acp_session,
            crate::ipc::sftp_upload,
            crate::ipc::sftp_download,
            crate::ipc::get_agent_cache,
            crate::ipc::list_wsl_distros,
            crate::ipc::list_wsl_directories,
            crate::ipc::get_wsl_home,
            crate::ipc::save_wsl_connection,
            crate::ipc::list_wsl_connections,
            // Integration management (Phase 55)
            crate::ipc::list_integrations,
            crate::ipc::save_integration,
            crate::ipc::delete_integration,
            crate::ipc::test_integration,
            // Project issue tracking config (Phase 55)
            crate::ipc::get_project_issue_tracking_config,
            crate::ipc::save_project_issue_tracking_config,
            crate::ipc::list_remote_issues,
            // Import / change detection (Phase 56)
            crate::ipc::import_tasks,
            crate::ipc::update_task_from_remote,
            crate::ipc::dismiss_task_change,
            // Issue tracking lookup (Phase 57)
            crate::ipc::check_github_owner,
            crate::ipc::list_github_repos,
            crate::ipc::list_jira_projects,
            crate::ipc::list_linear_teams,
            crate::ipc::list_gitlab_projects,
            crate::ipc::list_forgejo_repos,
            crate::ipc::list_gitea_repos,
            crate::ipc::list_azuredevops_projects,
            crate::ipc::list_azuredevops_repos,
            crate::ipc::list_bitbucket_repos,
            crate::ipc::list_bitbucket_projects,
            // Task attachments + interrupt (Phase 57)
            crate::ipc::list_task_attachments,
            crate::ipc::add_task_attachment,
            crate::ipc::delete_task_attachment,
            crate::ipc::proxy_image,
            crate::ipc::interrupt_task,
            // Task detail screen (Phase 62)
            crate::ipc::cancel_task,
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use specta_typescript::{BigIntExportBehavior, Typescript};

    #[test]
    fn generate_typescript_bindings() {
        create_builder()
            .export(
                Typescript::default().header("// @ts-nocheck").bigint(BigIntExportBehavior::Number),
                "../src/types/bindings.ts"
            )
            .expect("Failed to export TypeScript bindings");

        println!("✅ TypeScript bindings generated successfully");
    }
}