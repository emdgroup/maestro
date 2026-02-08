use crate::ssh::{RemoteSshSession, SshError};
use std::sync::Arc;

/// Create a worktree on the remote machine via SSH
///
/// Executes: cd {remote_path} && git worktree add {worktree_name} {branch}
pub async fn create_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    worktree_name: &str,
) -> Result<(), SshError> {
    let cmd = format!(
        "cd {} && git worktree add {} {}",
        remote_path, worktree_name, branch
    );
    ssh.execute_command(&cmd).await?;
    Ok(())
}

/// Delete a worktree on the remote machine via SSH
///
/// Executes multiple commands in sequence:
/// 1. cd {remote_path} && git worktree remove {worktree_name} --force
/// 2. git -C {remote_path} branch -D {worktree_name}
/// 3. git -C {remote_path} remote prune origin
pub async fn delete_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    worktree_name: &str,
) -> Result<(), SshError> {
    // Execute commands in sequence
    // Don't fail if branch delete or prune fails - the main goal is removing the worktree
    let remove_cmd = format!("cd {} && git worktree remove {} --force", remote_path, worktree_name);
    let _ = ssh.execute_command(&remove_cmd).await;

    let branch_delete_cmd = format!("git -C {} branch -D {}", remote_path, worktree_name);
    let _ = ssh.execute_command(&branch_delete_cmd).await;

    let prune_cmd = format!("git -C {} remote prune origin", remote_path);
    let _ = ssh.execute_command(&prune_cmd).await;

    Ok(())
}

/// Get git diff from the remote machine via SSH
///
/// Executes: cd {remote_path} && git diff --unified=6 {base_branch}...{branch}
pub async fn get_remote_diff(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    base_branch: &str,
) -> Result<String, SshError> {
    let cmd = format!(
        "cd {} && git diff --unified=6 {}...{}",
        remote_path, base_branch, branch
    );
    ssh.execute_command(&cmd).await
}

/// Get git status from the remote machine via SSH
///
/// Executes: cd {remote_path} && git status --short
pub async fn get_remote_status(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<String, SshError> {
    let cmd = format!("cd {} && git status --short", remote_path);
    ssh.execute_command(&cmd).await
}

/// List branches on the remote machine via SSH
///
/// Executes: cd {remote_path} && git branch -a
pub async fn list_remote_branches(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<Vec<String>, SshError> {
    let cmd = format!("cd {} && git branch -a", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    Ok(output
        .lines()
        .map(|s| s.trim().to_string())
        .collect())
}
