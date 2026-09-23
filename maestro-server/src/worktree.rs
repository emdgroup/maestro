//! Git worktrees, made and unmade by the daemon.
//!
//! The app has its own worktree code and keeps it, because it is the half that knows about tasks,
//! pull requests and its own `worktrees` table. This half exists because a scheduled run has to
//! provision a workspace with no window open, and because a run started here is the only thing that
//! knows when that workspace has stopped being worth keeping.
//!
//! Plain local `git`, with no `GitConnection` equivalent: the daemon already runs on the machine the
//! repository is on. That is the whole reason the app needs to tunnel git over SSH, WSL and Docker
//! and this does not.

use std::path::Path;

use crate::command_ext::NoConsoleWindow;

/// Where an automation's worktrees live, under the same root the app uses for its own.
const WORKTREE_DIR: &str = ".maestro/worktrees";

/// Run one git command in `dir`, returning its stdout.
async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("cannot run git {}: {e}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether `path` is inside a git working tree at all.
pub async fn is_repository(path: &str) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_ok_and(|out| out.trim() == "true")
}

/// A name safe to put in a path and a branch, derived from what the user called the automation.
///
/// Fixed at creation and stored, so renaming an automation leaves the worktrees its earlier runs
/// made exactly where they are. An automation named only in a script that yields nothing usable
/// falls back to a constant rather than to an empty segment.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = true;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            slug.extend(character.to_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "automation".to_string()
    } else {
        slug.chars().take(40).collect::<String>()
    }
}

/// Where one run's worktree goes, relative to the repository root.
pub fn relative_path(slug: &str, ordinal: i64) -> String {
    format!("{WORKTREE_DIR}/automation-{slug}-{ordinal}")
}

/// The branch that worktree is created on.
pub fn branch_name(slug: &str, ordinal: i64) -> String {
    format!("maestro/automation-{slug}-{ordinal}")
}

/// What one run got: an absolute directory and the branch checked out in it.
pub struct Provisioned {
    pub path: String,
    pub branch: String,
    /// What it was cut from, resolved here because an empty `base_branch` means whatever the
    /// repository was on at the time, and only this side can answer that.
    pub base: String,
}

/// Cut a worktree for one run, on a branch of its own.
///
/// `base_branch` empty means "wherever the repository is now", which is what an automation saved
/// before the editor offered a branch picker carries.
pub async fn create(
    project_path: &str,
    base_branch: &str,
    slug: &str,
    ordinal: i64,
) -> Result<Provisioned, String> {
    if !is_repository(project_path).await {
        return Err(format!(
            "{project_path} is not a git repository, so a worktree cannot be made there"
        ));
    }

    let relative = relative_path(slug, ordinal);
    let branch = branch_name(slug, ordinal);
    tokio::fs::create_dir_all(Path::new(project_path).join(WORKTREE_DIR))
        .await
        .map_err(|e| format!("cannot make {WORKTREE_DIR}: {e}"))?;

    let base = if base_branch.trim().is_empty() {
        git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await?
            .trim()
            .to_string()
    } else {
        base_branch.trim().to_string()
    };

    git(
        project_path,
        &["worktree", "add", &relative, "-b", &branch, &base],
    )
    .await?;

    Ok(Provisioned {
        path: format!("{project_path}/{relative}"),
        branch,
        base,
    })
}

/// Why this worktree must not be thrown away, or `None` when nothing would be lost.
///
/// The same two checks the app makes before reaping one of its own. The second is what matters:
/// a branch whose tip some *other* ref also contains has either been merged or been pushed, and
/// deleting it loses nothing. A repository with no remote falls on the keep side by construction,
/// which is the intended answer — there is nowhere else those commits exist.
pub async fn reason_to_keep(worktree_path: &str, branch: &str) -> Result<Option<String>, String> {
    let status = git(worktree_path, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        return Ok(Some("it has uncommitted changes".to_string()));
    }

    let containing = git(
        worktree_path,
        &[
            "branch",
            "--all",
            "--contains",
            "HEAD",
            "--format=%(refname:short)",
        ],
    )
    .await?;
    if !contained_elsewhere(&containing, branch) {
        return Ok(Some("its branch has commits of its own".to_string()));
    }

    Ok(None)
}

/// Whether anything other than `branch` itself contains the tip.
fn contained_elsewhere(containing: &str, branch: &str) -> bool {
    containing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // A detached worktree prints this instead of a name, and it is not another ref.
        .filter(|line| !line.starts_with("(HEAD detached"))
        .any(|line| line != branch)
}

/// Remove a worktree and the branch it was on.
///
/// The branch goes after the worktree because git refuses to delete a branch that is checked out
/// somewhere. `--force` on the worktree because a clean tree can still hold ignored build output,
/// and this is only ever called once `reason_to_keep` has said there is nothing to lose.
pub async fn remove(project_path: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    git(
        project_path,
        &["worktree", "remove", worktree_path, "--force"],
    )
    .await?;
    // A failure here leaves a branch with no worktree, which is untidy rather than harmful, so it
    // is reported without putting the worktree back.
    git(project_path, &["branch", "-D", branch]).await?;
    Ok(())
}

/// Remove a worktree and its branch whatever they hold, tolerating either being gone already.
///
/// For a run the user deleted, or one past its project's retention: nobody is asked whether the
/// work in it matters, which is what deleting a run means.
pub async fn discard(project_path: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    // A project that is gone took its worktrees with it, and there is no repository to ask.
    if !Path::new(project_path).is_dir() {
        return Ok(());
    }
    if Path::new(worktree_path).exists() {
        git(
            project_path,
            &["worktree", "remove", worktree_path, "--force"],
        )
        .await?;
    } else {
        git(project_path, &["worktree", "prune"]).await?;
    }
    if !git(project_path, &["branch", "--list", branch])
        .await?
        .trim()
        .is_empty()
    {
        git(project_path, &["branch", "-D", branch]).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slug_survives_whatever_the_automation_is_called() {
        assert_eq!(
            slugify("Nightly dependency audit"),
            "nightly-dependency-audit"
        );
        assert_eq!(slugify("  Release  notes!!  "), "release-notes");
        assert_eq!(slugify("Revue quotidienne"), "revue-quotidienne");
        assert_eq!(slugify("***"), "automation");
        assert_eq!(slugify(&"a".repeat(80)).len(), 40);
    }

    #[test]
    fn a_tip_only_its_own_branch_contains_is_worth_keeping() {
        let branch = "maestro/automation-audit-3";
        // Nothing else has these commits.
        assert!(!contained_elsewhere(branch, branch));
        // Merged into main, or pushed and therefore on the remote ref.
        assert!(contained_elsewhere(&format!("{branch}\nmain"), branch));
        assert!(contained_elsewhere(
            &format!("{branch}\norigin/{branch}"),
            branch
        ));
        // A detached head is not another ref holding the work.
        assert!(!contained_elsewhere("(HEAD detached at 1a2b3c4)", branch));
    }

    #[test]
    fn a_run_names_its_own_directory_and_branch() {
        assert_eq!(
            relative_path("audit", 3),
            ".maestro/worktrees/automation-audit-3"
        );
        assert_eq!(branch_name("audit", 3), "maestro/automation-audit-3");
    }

    #[tokio::test]
    async fn a_deleted_run_takes_its_worktree_and_branch_even_when_half_gone() {
        let repo = tempfile::tempdir().expect("tempdir");
        let project = repo.path().to_str().expect("utf-8 path");
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec![
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "root",
            ],
        ] {
            git(project, &args).await.expect("setup");
        }

        let whole = create(project, "", "audit", 1).await.expect("create");
        std::fs::write(Path::new(&whole.path).join("unsaved.txt"), "work").expect("dirty it");
        discard(project, &whole.path, &whole.branch)
            .await
            .expect("discard a dirty one");
        assert!(!Path::new(&whole.path).exists());

        // Somebody already deleted the directory by hand; the branch is still there.
        let half = create(project, "", "audit", 2).await.expect("create");
        std::fs::remove_dir_all(&half.path).expect("remove by hand");
        discard(project, &half.path, &half.branch)
            .await
            .expect("discard a half-gone one");

        let branches = git(project, &["branch", "--list", "maestro/*"])
            .await
            .expect("list");
        assert!(branches.trim().is_empty(), "left behind: {branches}");
    }
}
