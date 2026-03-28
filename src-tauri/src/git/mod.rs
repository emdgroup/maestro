/// Remote git operations module
pub mod remote;

use crate::models::GitConnection;

/// Public dispatcher: routes git operations to local OR remote based on GitConnection type
///
/// For local projects: Uses simple-git CLI via Node.js sidecar
/// For remote projects: Executes git commands via SSH
///
/// Callers don't need to know the difference - just pass a GitConnection and the operation works.

/// Create a worktree on the project (local or remote)
pub async fn create_worktree(
    conn: &GitConnection,
    branch: &str,
    worktree_name: &str,
) -> Result<(), String> {
    match conn {
        GitConnection::Local { path } => {
            create_worktree_local(path, branch, worktree_name).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::create_remote_worktree(ssh, remote_path, branch, worktree_name)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// Delete a worktree from the project (local or remote)
pub async fn delete_worktree(
    conn: &GitConnection,
    worktree_name: &str,
) -> Result<(), String> {
    match conn {
        GitConnection::Local { path } => {
            delete_worktree_local(path, worktree_name).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::delete_remote_worktree(ssh, remote_path, worktree_name)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// Get git diff for a branch (local or remote)
pub async fn git_diff(
    conn: &GitConnection,
    branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    match conn {
        GitConnection::Local { path } => {
            git_diff_local(path, branch, base_branch).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::get_remote_diff(ssh, remote_path, branch, base_branch)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// Get git status for the project (local or remote)
pub async fn git_status(
    conn: &GitConnection,
) -> Result<String, String> {
    match conn {
        GitConnection::Local { path } => {
            git_status_local(path).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::get_remote_status(ssh, remote_path)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// List branches in the project (local or remote)
pub async fn list_branches(
    conn: &GitConnection,
) -> Result<Vec<String>, String> {
    match conn {
        GitConnection::Local { path } => {
            list_branches_local(path).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::list_remote_branches(ssh, remote_path)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// Get the currently checked-out branch in the project (local or remote)
pub async fn get_current_branch(
    conn: &GitConnection,
) -> Result<String, String> {
    match conn {
        GitConnection::Local { path } => {
            get_current_branch_local(path).await
        }
        GitConnection::Remote { .. } => {
            // Remote current branch detection not implemented; default to main
            Ok("main".to_string())
        }
    }
}

// ============================================================================
// Local git operation implementations
// ============================================================================
// These are placeholders that should call the Node.js sidecar
// Implementation depends on Phase 3-01 sidecar integration being complete

async fn create_worktree_local(
    _path: &str,
    _branch: &str,
    _worktree_name: &str,
) -> Result<(), String> {
    // TODO: Phase 3-01 sidecar integration
    // Call: node sidecar/dist/index.js --create-worktree {path} {branch} {worktree_name}
    Err("Local git operations not yet implemented in dispatcher".to_string())
}

async fn delete_worktree_local(
    _path: &str,
    _worktree_name: &str,
) -> Result<(), String> {
    // TODO: Phase 3-01 sidecar integration
    // Call: node sidecar/dist/index.js --delete-worktree {path} {worktree_name}
    Err("Local git operations not yet implemented in dispatcher".to_string())
}

async fn git_diff_local(
    _path: &str,
    _branch: &str,
    _base_branch: &str,
) -> Result<String, String> {
    // TODO: Phase 3-01 sidecar integration
    // Call: node sidecar/dist/index.js --get-diff {path} {branch} {base_branch} {context_lines}
    Err("Local git operations not yet implemented in dispatcher".to_string())
}

async fn git_status_local(
    _path: &str,
) -> Result<String, String> {
    // TODO: Phase 3-01 sidecar integration
    // Call: node sidecar/dist/index.js --get-status {path}
    Err("Local git operations not yet implemented in dispatcher".to_string())
}

async fn list_branches_local(
    path: &str,
) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("git")
        .args(["branch", "-a"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<String> = stdout
        .lines()
        .map(|line| {
            // Strip leading whitespace and the current-branch asterisk
            let trimmed = line.trim_start_matches(|c: char| c == ' ' || c == '*').trim();
            // Strip "remotes/origin/" prefix for remote-tracking branches
            trimmed
                .strip_prefix("remotes/origin/")
                .unwrap_or(trimmed)
                .to_string()
        })
        .filter(|b| !b.is_empty() && !b.contains("HEAD ->") && !b.contains("HEAD"))
        .collect();

    // Deduplicate (local + remote-tracking may share names)
    branches.sort();
    branches.dedup();
    Ok(branches)
}

async fn get_current_branch_local(
    path: &str,
) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git rev-parse: {}", e))?;

    if !output.status.success() {
        return Ok("main".to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        Ok("main".to_string())
    } else {
        Ok(branch)
    }
}
