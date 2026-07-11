use crate::command_ext::NoConsoleWindow;
use crate::models::GitConnection;
use tokio::process::Command as TokioCommand;
use super::remote;
use super::exec::run_wsl_git;

#[derive(serde::Serialize, specta::Type)]
pub struct BranchList {
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

/// Parsed worktree entry from `git worktree list --porcelain`
pub struct ParsedWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_prunable: bool,
}

/// Create a worktree on the project (local, remote, or WSL)
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
        GitConnection::Wsl { distro, path } => {
            let args: Vec<&str> = if let Some(nb) = new_branch {
                vec!["worktree", "add", worktree_name, "-b", nb, branch]
            } else {
                vec!["worktree", "add", worktree_name, branch]
            };
            run_wsl_git(distro, path, &args, false).await.map(|_| ())
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
        GitConnection::Wsl { distro, path } => {
            run_wsl_git(distro, path, &["worktree", "remove", worktree_name, "--force"], false).await.map(|_| ())
        }
    }
}

/// Get git diff for a branch (local or remote)
pub async fn git_diff(
    conn: &GitConnection,
    branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    crate::acp::manager::append_debug_log(&format!(
        "[git] diff branch={branch:?} base={base_branch:?} conn={}",
        match conn {
            GitConnection::Local { path } => format!("local path={path}"),
            GitConnection::Remote { remote_path, .. } => format!("remote path={remote_path}"),
            GitConnection::Wsl { distro, path } => format!("wsl distro={distro} path={path}"),
        }
    ));
    let result = match conn {
        GitConnection::Local { path } => {
            git_diff_local(path, branch, base_branch).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::get_remote_diff(ssh, remote_path, branch, base_branch)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
        GitConnection::Wsl { distro, path } => {
            let range = format!("{}...{}", base_branch, branch);
            run_wsl_git(distro, path, &["diff", "--unified=6", &range], false).await
        }
    };
    if let Err(ref e) = result {
        crate::acp::manager::append_debug_log(&format!("[git] diff FAILED: {e}"));
    }
    result
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
        GitConnection::Wsl { distro, path } => {
            run_wsl_git(distro, path, &["status", "--porcelain"], false).await
        }
    }
}

/// List branches in the project (local or remote)
pub async fn list_branches(
    conn: &GitConnection,
) -> Result<BranchList, String> {
    match conn {
        GitConnection::Local { path } => {
            list_branches_local(path).await
        }
        GitConnection::Remote { ssh, remote_path } => {
            remote::list_remote_branches(ssh, remote_path)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
        GitConnection::Wsl { distro, path } => {
            let raw = run_wsl_git(distro, path, &["branch", "-a", "--format=%(refname:short)"], false).await?;
            Ok(parse_branch_list(raw.lines()))
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
        GitConnection::Wsl { distro, path } => {
            let raw = run_wsl_git(distro, path, &["symbolic-ref", "--short", "HEAD"], false).await?;
            Ok(raw.trim().to_string())
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
        GitConnection::Wsl { distro, path } => {
            let raw = run_wsl_git(distro, path, &["worktree", "list", "--porcelain"], false).await?;
            Ok(parse_worktree_list(&raw))
        }
    }
}

/// List all worktrees via `git worktree list --porcelain`
pub async fn list_worktrees_local(repo_path: &str) -> Result<Vec<ParsedWorktree>, String> {
    let output = TokioCommand::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .no_console_window()
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
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git status in {}: {}", worktree_abs_path, e))?;

    // Don't fail on non-zero exit — just return empty string
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

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
        .no_console_window()
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
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {}", stderr));
    }
    Ok(())
}

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024; // 2 MB

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

async fn git_diff_local(
    path: &str,
    branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(["diff", "--unified=6", &format!("{}...{}", base_branch, branch)])
        .current_dir(path)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git diff failed: {}", stderr));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    if raw.len() > MAX_DIFF_BYTES {
        let cut = floor_char_boundary(&raw, MAX_DIFF_BYTES);
        Ok(format!(
            "{}\n// [diff truncated: {} MB total]\n",
            &raw[..cut],
            raw.len() / 1_048_576
        ))
    } else {
        Ok(raw.into_owned())
    }
}

async fn git_status_local(
    path: &str,
) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn parse_branch_list<'a>(lines: impl Iterator<Item = &'a str>) -> BranchList {
    let mut local: Vec<String> = Vec::new();
    let mut remote: Vec<String> = Vec::new();
    for line in lines {
        if let Some(name) = line.strip_prefix("origin/") {
            if !name.is_empty() && name != "HEAD" {
                remote.push(name.to_string());
            }
        } else if !line.is_empty() && line != "HEAD" {
            local.push(line.to_string());
        }
    }
    local.sort();
    local.dedup();
    remote.sort();
    remote.dedup();
    // Drop remote entries that already exist as local branches (same branch, no need to show twice)
    remote.retain(|r| local.binary_search(r).is_err());
    BranchList { local, remote }
}

async fn list_branches_local(
    path: &str,
) -> Result<BranchList, String> {
    let output = TokioCommand::new("git")
        .args(["branch", "-a", "--format=%(refname:short)"])
        .current_dir(path)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git branch failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_branch_list(stdout.lines()))
}

async fn get_current_branch_local(
    path: &str,
) -> Result<String, String> {
    // symbolic-ref reads .git/HEAD directly — works for both normal and unborn branches.
    // rev-parse fails on unborn branches (no commits yet), so we avoid it here.
    let output = TokioCommand::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(path)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run git symbolic-ref: {}", e))?;

    if !output.status.success() {
        // Detached HEAD — fall back to rev-parse for the commit hash short-ref
        return Ok("main".to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        Ok("main".to_string())
    } else {
        Ok(branch)
    }
}
