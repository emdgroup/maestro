use crate::models::GitConnection;
use super::exec::{run_git_in_dir, run_git_in_dir_lossy};

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

/// Create a worktree in the project repository.
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
    let args: Vec<&str> = match new_branch {
        Some(nb) => vec!["worktree", "add", worktree_name, "-b", nb, branch],
        None => vec!["worktree", "add", worktree_name, branch],
    };
    run_git_in_dir(conn, conn.path(), &args).await.map(|_| ())
}

/// Remove a worktree from the project repository.
///
/// `worktree_name` is the worktree's path relative to the repository, not a branch name. The
/// branch is left alone: callers decide whether to delete it, and `cleanup_worktree_if_clean`
/// must be able to inspect it after the working tree is gone.
///
/// Pair this with [`prune_remote_refs`] once the caller is done removing worktrees.
pub async fn delete_worktree(
    conn: &GitConnection,
    worktree_name: &str,
) -> Result<(), String> {
    run_git_in_dir(conn, conn.path(), &["worktree", "remove", worktree_name, "--force"])
        .await
        .map(|_| ())
}

/// Drop remote-tracking refs for branches that no longer exist upstream, so the base-branch
/// picker stops offering them.
///
/// Best-effort, and deliberately *not* part of [`delete_worktree`]: this contacts the remote, so
/// a caller removing several worktrees must call it once at the end rather than once per
/// worktree, and an unreachable origin then costs one stalled request instead of N.
///
/// Only ever removes `origin/*` refs — never a local branch, never a commit.
pub async fn prune_remote_refs(conn: &GitConnection) {
    if let Err(e) = run_git_in_dir_lossy(conn, conn.path(), &["remote", "prune", "origin"]).await {
        log::debug!("[git] pruning remote-tracking refs failed: {e}");
    }
}

/// Push `branch` to `remote`, setting it as the branch's upstream.
///
/// Runs down the same exec channel as every other git command, which means it executes on the
/// machine that owns the repository and uses *that* machine's git configuration — its SSH agent,
/// its credential helper, its `~/.gitconfig`. Maestro holds no credential of its own, which is
/// why this needs no per-connection branch: the host the user already pushes from by hand is the
/// host doing the pushing.
///
/// A missing or wrong credential therefore surfaces as git's own message rather than as
/// something we invent. It cannot hang waiting for one either — the exec channel gives git a
/// null stdin, so git has no terminal to prompt on and fails instead.
pub async fn push_branch(
    conn: &GitConnection,
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<(), String> {
    run_git_in_dir(conn, repo_path, &["push", "--set-upstream", remote, branch]).await?;
    Ok(())
}

pub async fn git_status(conn: &GitConnection) -> Result<String, String> {
    run_git_in_dir(conn, conn.path(), &["status", "--porcelain"]).await
}

pub async fn list_branches(conn: &GitConnection) -> Result<BranchList, String> {
    let raw = run_git_in_dir(conn, conn.path(), &["branch", "-a", "--format=%(refname:short)"]).await?;
    Ok(parse_branch_list(raw.lines()))
}

/// The branch checked out in the project repository, or `main` when there is none to name.
///
/// `symbolic-ref` reads `.git/HEAD` directly, so it works on an unborn branch where `rev-parse`
/// fails. It exits non-zero on a detached HEAD, which is not an error worth surfacing here.
pub async fn get_current_branch(conn: &GitConnection) -> Result<String, String> {
    let raw = run_git_in_dir_lossy(conn, conn.path(), &["symbolic-ref", "--short", "HEAD"]).await?;
    let branch = raw.trim();
    if branch.is_empty() {
        Ok("main".to_string())
    } else {
        Ok(branch.to_string())
    }
}

pub async fn list_worktrees(conn: &GitConnection) -> Result<Vec<ParsedWorktree>, String> {
    let raw = run_git_in_dir(conn, conn.path(), &["worktree", "list", "--porcelain"]).await?;
    Ok(parse_worktree_list(&raw))
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
