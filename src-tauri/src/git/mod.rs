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
    _path: &str,
) -> Result<Vec<String>, String> {
    // TODO: Phase 3-01 sidecar integration
    // Call: node sidecar/dist/index.js --list-branches {path}
    Err("Local git operations not yet implemented in dispatcher".to_string())
}
