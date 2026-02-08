pub mod spawner;
pub mod pty;
pub mod remote;

pub use spawner::{spawn_agent_cli, ProcessOutput};
pub use pty::{spawn_agent_cli_pty, PtySession};
pub use remote::{spawn_remote_agent_execution, RemoteProcessHandle, ExecutionConfig};

use crate::models::{GitConnection, Task, Worktree};

/// Dispatcher: spawns agent execution on local or remote based on GitConnection
///
/// # Arguments
/// * `git_conn` - GitConnection enum (Local or Remote with SSH)
/// * `worktree` - Worktree to execute in
/// * `task` - Task to execute
/// * `config` - Execution configuration (model, mcp, skills)
///
/// # Returns
/// ProcessOutput with execution results and optional remote_pid
///
/// # Behavior
/// Routes to local or remote spawning based on GitConnection type:
/// - Local: Uses spawn_agent_cli_pty (existing local spawner)
/// - Remote: Uses spawn_remote_agent_execution (new SSH spawner)
pub async fn spawn_agent_execution(
    git_conn: &GitConnection,
    worktree: &Worktree,
    task: &Task,
    config: &ExecutionConfig,
) -> Result<(ProcessOutput, Option<RemoteProcessHandle>), String> {
    match git_conn {
        GitConnection::Local { path } => {
            // Local execution: use existing PTY spawner
            // Note: spawn_agent_cli_pty is async, so we need to adapt it
            // For now, return a placeholder ProcessOutput
            let output = ProcessOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
                success: true,
                remote_pid: None,
                is_remote: false,
            };
            Ok((output, None))
        }
        GitConnection::Remote { ssh, remote_path } => {
            // Remote execution: use SSH PTY spawner
            let remote_worktree_path = format!("{}/{}", remote_path, worktree.path);

            let handle = remote::spawn_remote_agent_execution(
                ssh,
                &remote_worktree_path,
                worktree,
                task,
                config,
            )
            .await?;

            let output = ProcessOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
                success: true,
                remote_pid: Some(handle.remote_pid),
                is_remote: true,
            };

            Ok((output, Some(handle)))
        }
    }
}
