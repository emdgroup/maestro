/// Remote git operations module
pub mod remote;

use crate::models::GitConnection;
use tokio::process::Command as TokioCommand;

/// Parsed worktree entry from `git worktree list --porcelain`
pub struct ParsedWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_prunable: bool,
}

/// Public dispatcher: routes git operations to local OR remote based on GitConnection type
///
/// For local projects: Uses tokio::process::Command to run git CLI directly
/// For remote projects: Executes git commands via SSH
///
/// Callers don't need to know the difference - just pass a GitConnection and the operation works.

/// Create a worktree on the project (local or remote)
///
/// `branch` is the base branch (e.g. origin branch) to create from or check out.
/// `new_branch` is an optional name for a new branch to create from `branch`.
/// When `new_branch` is None, the existing `branch` is checked out directly.
pub async fn create_worktree(
    conn: &GitConnection,
    branch: &str,
    worktree_name: &str,
    new_branch: Option<&str>,
) -> Result<(), String> {
    match conn {
        GitConnection::Local { path } => {
            create_worktree_local(path, branch, worktree_name, new_branch).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::create_remote_worktree(ssh, remote_path, branch, worktree_name, new_branch)
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
        GitConnection::Remote { ssh, remote_path } => {
            remote::get_remote_current_branch(ssh, remote_path)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// List worktrees in the project (local or remote)
pub async fn list_worktrees(
    conn: &GitConnection,
) -> Result<Vec<ParsedWorktree>, String> {
    match conn {
        GitConnection::Local { path } => {
            list_worktrees_local(path).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::list_remote_worktrees(ssh, remote_path)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
    }
}

/// List all worktrees via `git worktree list --porcelain`
pub async fn list_worktrees_local(repo_path: &str) -> Result<Vec<ParsedWorktree>, String> {
    let output = TokioCommand::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree list failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_list(&stdout))
}

/// Parse a single line from `git branch -a` output into a bare branch name.
/// Strips leading markers (`*` current branch, `+` worktree-checked-out branch),
/// whitespace, and the `remotes/origin/` prefix for remote-tracking refs.
pub fn parse_branch_line(line: &str) -> String {
    let trimmed = line.trim_start_matches(|c: char| c == ' ' || c == '*' || c == '+').trim();
    trimmed
        .strip_prefix("remotes/origin/")
        .unwrap_or(trimmed)
        .to_string()
}

pub fn parse_worktree_list(output: &str) -> Vec<ParsedWorktree> {
    output.split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut path = String::new();
            let mut branch = None;
            let mut head = String::new();
            let mut is_prunable = false;

            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = p.to_string();
                } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(b.to_string());
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    head = h.to_string();
                } else if line.starts_with("prunable") {
                    is_prunable = true;
                }
            }

            ParsedWorktree { path, branch, head, is_prunable }
        })
        .collect()
}

/// Get git status --porcelain for a specific worktree path
pub async fn get_worktree_status_local(worktree_abs_path: &str) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_abs_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git status in {}: {}", worktree_abs_path, e))?;

    // Don't fail on non-zero exit — just return empty string
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ============================================================================
// Local git operation implementations using tokio::process::Command
// ============================================================================

async fn create_worktree_local(
    path: &str,
    branch: &str,
    worktree_name: &str,
    new_branch: Option<&str>,
) -> Result<(), String> {
    // When new_branch is Some: git worktree add {worktree_name} -b {new_branch} {branch}
    // When new_branch is None: git worktree add {worktree_name} {branch}  (checkout existing)
    let args: Vec<&str> = if let Some(nb) = new_branch {
        vec!["worktree", "add", worktree_name, "-b", nb, branch]
    } else {
        vec!["worktree", "add", worktree_name, branch]
    };

    let output = TokioCommand::new("git")
        .args(&args)
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }
    Ok(())
}

async fn delete_worktree_local(
    path: &str,
    worktree_name: &str,
) -> Result<(), String> {
    let output = TokioCommand::new("git")
        .args(["worktree", "remove", worktree_name, "--force"])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {}", stderr));
    }
    Ok(())
}

async fn git_diff_local(
    path: &str,
    branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(["diff", "--unified=6", &format!("{}...{}", base_branch, branch)])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn git_status_local(
    path: &str,
) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn list_branches_local(
    path: &str,
) -> Result<Vec<String>, String> {
    let output = TokioCommand::new("git")
        .args(["branch", "-a"])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches: Vec<String> = stdout
        .lines()
        .map(parse_branch_line)
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
    let output = TokioCommand::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .await
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
