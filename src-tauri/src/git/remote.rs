use crate::ssh::{RemoteSshSession, SshError};
use std::sync::Arc;

/// Create a worktree on the remote machine via SSH
///
/// Executes (new_branch = Some): cd '{remote_path}' && git worktree add '{worktree_name}' -b '{new_branch}' '{branch}'
/// Executes (new_branch = None): cd '{remote_path}' && git worktree add '{worktree_name}' '{branch}'
pub async fn create_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    worktree_name: &str,
    new_branch: Option<&str>,
) -> Result<(), SshError> {
    let cmd = match new_branch {
        Some(nb) => format!(
            "cd '{}' && git worktree add '{}' -b '{}' '{}'",
            remote_path, worktree_name, nb, branch
        ),
        None => format!(
            "cd '{}' && git worktree add '{}' '{}'",
            remote_path, worktree_name, branch
        ),
    };
    ssh.execute_command(&cmd).await?;
    Ok(())
}

/// Delete a worktree on the remote machine via SSH
///
/// Executes multiple commands in sequence:
/// 1. cd '{remote_path}' && git worktree remove '{worktree_name}' --force
/// 2. git -C '{remote_path}' branch -D '{worktree_name}'
/// 3. git -C '{remote_path}' remote prune origin
pub async fn delete_remote_worktree(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    worktree_name: &str,
) -> Result<(), SshError> {
    // Execute commands in sequence
    // Don't fail if branch delete or prune fails - the main goal is removing the worktree
    let remove_cmd = format!("cd '{}' && git worktree remove '{}' --force", remote_path, worktree_name);
    let _ = ssh.execute_command(&remove_cmd).await;

    let branch_delete_cmd = format!("git -C '{}' branch -D '{}'", remote_path, worktree_name);
    let _ = ssh.execute_command(&branch_delete_cmd).await;

    let prune_cmd = format!("git -C '{}' remote prune origin", remote_path);
    let _ = ssh.execute_command(&prune_cmd).await;

    Ok(())
}

/// Get git diff from the remote machine via SSH
///
/// Executes: cd '{remote_path}' && git diff --unified=6 {base_branch}...{branch}
pub async fn get_remote_diff(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    branch: &str,
    base_branch: &str,
) -> Result<String, SshError> {
    let cmd = format!(
        "cd '{}' && git diff --unified=6 {}...{}",
        remote_path, base_branch, branch
    );
    ssh.execute_command(&cmd).await
}

/// Get git status from the remote machine via SSH
///
/// Executes: cd '{remote_path}' && git status --short
pub async fn get_remote_status(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<String, SshError> {
    let cmd = format!("cd '{}' && git status --short", remote_path);
    ssh.execute_command(&cmd).await
}

/// List branches on the remote machine via SSH
///
/// Executes: cd '{remote_path}' && git branch -a
/// Returns normalized, deduplicated branch names (strips asterisk and remotes/origin/ prefix).
pub async fn list_remote_branches(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<Vec<String>, SshError> {
    let cmd = format!("cd '{}' && git branch -a", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    let mut branches: Vec<String> = output
        .lines()
        .map(|line| {
            let trimmed = line.trim_start_matches(|c: char| c == ' ' || c == '*').trim();
            trimmed
                .strip_prefix("remotes/origin/")
                .unwrap_or(trimmed)
                .to_string()
        })
        .filter(|b| !b.is_empty() && !b.contains("HEAD ->") && !b.contains("HEAD"))
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

/// Get the currently checked-out branch on the remote machine via SSH
///
/// Executes: cd '{remote_path}' && git rev-parse --abbrev-ref HEAD
pub async fn get_remote_current_branch(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<String, SshError> {
    let cmd = format!("cd '{}' && git rev-parse --abbrev-ref HEAD", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    let branch = output.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        Ok("main".to_string())
    } else {
        Ok(branch)
    }
}

/// List all worktrees on the remote machine via SSH
///
/// Executes: cd '{remote_path}' && git worktree list --porcelain
/// Reuses the local parser from crate::git::parse_worktree_list.
pub async fn list_remote_worktrees(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
) -> Result<Vec<crate::git::ParsedWorktree>, SshError> {
    let cmd = format!("cd '{}' && git worktree list --porcelain", remote_path);
    let output = ssh.execute_command(&cmd).await?;
    Ok(crate::git::parse_worktree_list(&output))
}
