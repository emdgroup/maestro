use crate::models::GitConnection;
use super::exec::{run_git_commands_lossy, run_git_in_dir, run_git_in_dir_lossy};

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

/// The local branch a checkout of `base` lands on, when `base` names a remote-tracking ref.
///
/// `origin/foo` resolves to `foo` — the expansion `git worktree add` performs itself when no
/// local branch by that name exists. Making it explicit is what keeps it happening once one
/// does: git's own DWIM would then check out the local branch instead, which is not the ref the
/// user picked and can sit at an entirely different commit.
///
/// Asks git rather than stripping the prefix, because a local branch may itself be named
/// `origin/foo` — it lives at `refs/heads/origin/foo`. That one takes precedence and yields
/// `None`, so the name the Local tab offers always means the local branch.
pub async fn local_branch_for(conn: &GitConnection, base: &str) -> Option<String> {
    let (_remote_name, rest) = base.split_once('/')?;
    if rest.is_empty() {
        return None;
    }

    // `rev-parse --verify --quiet` prints the sha on success and nothing on failure, so emptiness
    // is the answer. `show-ref --quiet` prints nothing either way and cannot be read through the
    // lossy helper, which reports a failed command as an empty string.
    let head_ref = format!("refs/heads/{}", base);
    let remote_ref = format!("refs/remotes/{}", base);
    let probes: Vec<Vec<&str>> = vec![
        vec!["rev-parse", "--verify", "--quiet", &head_ref],
        vec!["rev-parse", "--verify", "--quiet", &remote_ref],
    ];
    let as_slices: Vec<&[&str]> = probes.iter().map(Vec::as_slice).collect();
    let mut outputs = run_git_commands_lossy(conn, conn.path(), &as_slices).await.into_iter();

    let local_exists = !outputs.next().unwrap_or_default().trim().is_empty();
    let remote_exists = !outputs.next().unwrap_or_default().trim().is_empty();

    (!local_exists && remote_exists).then(|| rest.to_string())
}

/// Create a worktree in the project repository, returning the branch it ends up on.
///
/// `branch` is the base to create from or check out — a local name, or a `<remote>/`-qualified
/// one from the picker's Remote tab. `new_branch` names a branch to create from it; `None`
/// checks `branch` out where it is.
///
/// The `--track -b` form for a remote base is git's own documented DWIM expansion, written out
/// so it still applies when a local branch shadows the remote one. The returned name is what the
/// caller must record: for a remote checkout the worktree sits on `foo`, not on `origin/foo`.
pub async fn create_worktree(
    conn: &GitConnection,
    branch: &str,
    worktree_name: &str,
    new_branch: Option<&str>,
) -> Result<String, String> {
    if let Some(nb) = new_branch {
        run_git_in_dir(conn, conn.path(), &["worktree", "add", worktree_name, "-b", nb, branch])
            .await?;
        return Ok(nb.to_string());
    }

    if let Some(local) = local_branch_for(conn, branch).await {
        run_git_in_dir(
            conn,
            conn.path(),
            &["worktree", "add", "--track", "-b", &local, worktree_name, branch],
        )
        .await?;
        return Ok(local);
    }

    run_git_in_dir(conn, conn.path(), &["worktree", "add", worktree_name, branch]).await?;
    Ok(branch.to_string())
}

/// Remove a worktree from the project repository.
///
/// `worktree_name` is the worktree's path relative to the repository, not a branch name. The
/// branch is left alone: callers decide whether to delete it, and `cleanup_worktree_if_clean`
/// must be able to inspect it after the working tree is gone.
///
/// `Ok` means git no longer tracks the worktree — not that the directory is necessarily gone. A
/// directory can survive removal while a process outside Maestro holds it open, and that outcome
/// must not be reported as failure: everything the caller does next (deleting the branch, the DB
/// row) is still both valid and necessary, and failing here strands all of it behind an error
/// about a directory. `cleanup_zombie_worktrees` sweeps the leftover on the next project open.
///
/// Pair this with [`prune_remote_refs`] once the caller is done removing worktrees.
pub async fn delete_worktree(
    conn: &GitConnection,
    worktree_name: &str,
) -> Result<(), String> {
    let Err(git_error) =
        run_git_in_dir(conn, conn.path(), &["worktree", "remove", worktree_name, "--force"]).await
    else {
        return Ok(());
    };

    // `git worktree remove` unregisters the worktree *before* deleting its directory and keeps
    // going when that deletion fails, so a failure leaves a directory git no longer lists and no
    // later run ever retries — the leftovers accumulate invisibly. Finish the job here instead.
    if !conn.is_on_this_machine() {
        return Err(git_error);
    }
    let Some(absolute) = removable_worktree_dir(conn.path(), worktree_name) else {
        return Err(git_error);
    };

    if let Err(e) = remove_dir_with_retries(&absolute).await {
        if still_registered(conn, &absolute).await {
            return Err(format!("{git_error}; removing {absolute} also failed: {e}"));
        }
        log::warn!(
            "[git] worktree {absolute} is unregistered but its directory could not be removed: {e}"
        );
    } else {
        log::warn!("[git] worktree remove failed ({git_error}); removed {absolute} directly");
    }
    // The admin entry is normally already gone, but not on every failure path.
    run_git_in_dir_lossy(conn, conn.path(), &["worktree", "prune"]).await?;
    Ok(())
}

/// How hard [`delete_worktree`] tries to remove a directory something else is holding open.
///
/// On Windows an open handle — most often a process whose working directory the worktree still is
/// — blocks the removal outright rather than deferring it. Whatever held it is usually a child of
/// the session that just ended and exits a moment later, so a short retry turns the common case
/// into a clean removal. Beyond about a second the holder is not going away and the user is only
/// being made to wait for it.
const WORKTREE_REMOVAL_ATTEMPTS: u32 = 5;
const WORKTREE_REMOVAL_BACKOFF: std::time::Duration = std::time::Duration::from_millis(200);

/// Remove a directory, retrying while something still holds it open. Already gone counts as
/// removed.
async fn remove_dir_with_retries(absolute: &str) -> Result<(), std::io::Error> {
    let mut attempt = 1;
    loop {
        match tokio::fs::remove_dir_all(absolute).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if attempt >= WORKTREE_REMOVAL_ATTEMPTS => return Err(e),
            Err(_) => {
                tokio::time::sleep(WORKTREE_REMOVAL_BACKOFF).await;
                attempt += 1;
            }
        }
    }
}

/// Whether git still lists `absolute` as a worktree of this repository.
///
/// This is what separates git refusing to remove a worktree at all from git having unregistered it
/// and only the directory surviving — two failures that arrive as the same error string. A
/// worktree list that cannot be read answers "yes", so an unknown state falls on the side of
/// reporting the failure rather than silently continuing.
async fn still_registered(conn: &GitConnection, absolute: &str) -> bool {
    let target = absolute.trim_end_matches('/');
    match list_worktrees(conn).await {
        Ok(worktrees) => worktrees
            .iter()
            .any(|worktree| worktree.path.replace('\\', "/").trim_end_matches('/') == target),
        Err(e) => {
            log::warn!("[git] could not read the worktree list to classify a removal failure: {e}");
            true
        }
    }
}

/// The absolute path of `worktree_name` when it is a worktree maestro created inside `repo_path`,
/// which is the only case where deleting the directory outright is safe. `worktree_name` may be
/// relative to the repository or absolute, with either separator.
fn removable_worktree_dir(repo_path: &str, worktree_name: &str) -> Option<String> {
    let repo = repo_path.replace('\\', "/");
    let repo = repo.trim_end_matches('/');
    let worktree = worktree_name.replace('\\', "/");

    let absolute = if worktree.starts_with(&format!("{repo}/")) {
        worktree
    } else {
        format!("{repo}/{worktree}")
    };
    let is_maestro_created = absolute
        .strip_prefix(&format!("{repo}/"))
        .is_some_and(crate::models::is_maestro_created_worktree);
    is_maestro_created.then_some(absolute)
}

/// Drop remote-tracking refs for branches that no longer exist upstream, so the base-branch
/// picker stops offering them.
///
/// Best-effort, and deliberately *not* part of [`delete_worktree`]: this contacts the remote, so
/// a caller removing several worktrees must call it once at the end rather than once per
/// worktree, and an unreachable remote then costs one stalled request instead of N.
///
/// Only ever removes `<remote>/*` refs — never a local branch, never a commit.
pub async fn prune_remote_refs(conn: &GitConnection, remote: &str) {
    if let Err(e) = run_git_in_dir_lossy(conn, conn.path(), &["remote", "prune", remote]).await {
        log::debug!("[git] pruning remote-tracking refs for {remote} failed: {e}");
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

/// Every branch of the repository, split into local names and `<remote>/`-qualified remote ones.
///
/// Asks for full refnames rather than `branch -a --format=%(refname:short)`. Shortening is lossy
/// in exactly the way that matters here: `refs/remotes/origin/HEAD` shortens to the bare string
/// `origin`, which has no `origin/` prefix to strip and so used to be reported as a local branch.
pub async fn list_branches(conn: &GitConnection, remote: &str) -> Result<BranchList, String> {
    let remote_namespace = format!("refs/remotes/{}", remote);
    let raw = run_git_in_dir(
        conn,
        conn.path(),
        &["for-each-ref", "--format=%(refname)", "refs/heads", &remote_namespace],
    )
    .await?;
    Ok(parse_branch_list(raw.lines(), remote))
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

/// Classify `for-each-ref --format=%(refname)` output into the two lists the picker shows.
///
/// Remote entries keep their `<remote>/` prefix, because that is what they are: a separate ref
/// that can sit at a different commit from a local branch of the same name. They used to be
/// stored bare and then deduplicated against the local list, which hid precisely the branches a
/// user opens the Remote tab to find.
///
/// `<remote>/HEAD` is dropped — it is a symbolic pointer at the remote's default branch, which
/// is already listed under its own name.
pub fn parse_branch_list<'a>(lines: impl Iterator<Item = &'a str>, remote_name: &str) -> BranchList {
    let remote_prefix = format!("refs/remotes/{}/", remote_name);
    let mut local: Vec<String> = Vec::new();
    let mut remote: Vec<String> = Vec::new();

    for line in lines {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("refs/heads/") {
            if !name.is_empty() {
                local.push(name.to_string());
            }
        } else if let Some(name) = line.strip_prefix(&remote_prefix) {
            if !name.is_empty() && name != "HEAD" {
                remote.push(format!("{}/{}", remote_name, name));
            }
        }
    }

    local.sort();
    local.dedup();
    remote.sort();
    remote.dedup();
    BranchList { local, remote }
}

#[cfg(test)]
mod tests {
    use super::{parse_branch_list, remove_dir_with_retries, removable_worktree_dir};

    /// The two lists must be exactly `refs/heads/*` and `refs/remotes/<remote>/*`.
    ///
    /// Both halves of this used to be wrong. `refs/remotes/origin/HEAD` shortens to the bare word
    /// `origin`, which has no `origin/` prefix to strip and so was reported as a local branch; and
    /// remote entries were stored bare and then deduplicated against the local list, hiding every
    /// remote branch whose name a local branch happened to share.
    #[test]
    fn branches_are_split_by_namespace_not_by_shortened_name() {
        let refs = concat!(
            "refs/heads/main\n",
            "refs/heads/rebuild-worktree-card\n",
            "refs/heads/maestro/kind-canyon-49\n",
            "refs/remotes/origin/HEAD\n",
            "refs/remotes/origin/main\n",
            "refs/remotes/origin/rebuild-worktree-card\n",
            "refs/remotes/origin/chore/agent-registry-20260810\n",
        );

        let branches = parse_branch_list(refs.lines(), "origin");

        assert_eq!(branches.local, vec!["maestro/kind-canyon-49", "main", "rebuild-worktree-card"]);
        assert_eq!(
            branches.remote,
            vec![
                "origin/chore/agent-registry-20260810",
                "origin/main",
                "origin/rebuild-worktree-card",
            ],
            "a name existing locally must not hide the remote ref, which can be at another commit"
        );
    }

    /// Only the configured remote's namespace is listed; another remote's refs are not the
    /// project's branches and must not be offered as bases.
    #[test]
    fn only_the_configured_remote_is_listed() {
        let refs = concat!(
            "refs/heads/main\n",
            "refs/remotes/fork/HEAD\n",
            "refs/remotes/fork/main\n",
            "refs/remotes/fork/experiment\n",
        );

        let branches = parse_branch_list(refs.lines(), "fork");
        assert_eq!(branches.local, vec!["main"]);
        assert_eq!(branches.remote, vec!["fork/experiment", "fork/main"]);

        // The same refs read against a remote the project does not have.
        let branches = parse_branch_list(refs.lines(), "origin");
        assert_eq!(branches.local, vec!["main"]);
        assert!(branches.remote.is_empty());
    }

    /// The fallback in `delete_worktree` removes a directory outright, so it must only ever fire
    /// for a worktree maestro created inside the repository.
    #[test]
    fn only_maestro_worktrees_inside_the_repo_are_removable() {
        let repo = r"C:\Users\me\proj";
        let expected = Some("C:/Users/me/proj/.maestro/worktrees/session-22".to_string());

        assert_eq!(removable_worktree_dir(repo, ".maestro/worktrees/session-22"), expected);
        assert_eq!(removable_worktree_dir(repo, r"C:\Users\me\proj\.maestro\worktrees\session-22"), expected);
        assert_eq!(removable_worktree_dir(repo, "C:/Users/me/proj/.maestro/worktrees/session-22"), expected);
        assert_eq!(removable_worktree_dir("/home/me/proj", ".maestro/worktrees/task-3"), Some("/home/me/proj/.maestro/worktrees/task-3".to_string()));

        // A worktree the user made by hand, and one outside the repository entirely.
        assert_eq!(removable_worktree_dir(repo, "scratch"), None);
        assert_eq!(removable_worktree_dir(repo, "C:/elsewhere/.maestro/worktrees/session-1"), None);
        assert_eq!(removable_worktree_dir(repo, "../.maestro/worktrees/session-1"), None);
    }

    /// The retry loop must still treat "already gone" as done rather than spending the full
    /// backoff on a directory `git worktree remove` had in fact deleted.
    #[tokio::test]
    async fn removal_succeeds_whether_the_directory_is_there_or_not() {
        let temp = tempfile::tempdir().expect("temp dir");
        let target = temp.path().join("session-1");
        std::fs::create_dir_all(target.join("src")).expect("create dir");

        let path = target.to_string_lossy().to_string();
        let started = std::time::Instant::now();
        remove_dir_with_retries(&path).await.expect("remove existing");
        assert!(!target.exists());
        remove_dir_with_retries(&path).await.expect("remove missing");
        assert!(started.elapsed() < super::WORKTREE_REMOVAL_BACKOFF, "no retry was needed");
    }
}
