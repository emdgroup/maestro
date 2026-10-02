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

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use crate::command_ext::NoConsoleWindow;

/// Where an automation's worktrees live, under the same root the app uses for its own.
const WORKTREE_DIR: &str = ".maestro/worktrees";

/// One lock per project, taken around `git worktree add`: two adds at once in one repository race
/// on its `.git/worktrees` and config locks, and one of them fails.
// ponytail: an entry per project ever seen, never pruned; projects on one machine are few.
static ADDING: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

async fn adding(project_path: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = Arc::clone(
        ADDING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(project_path.to_string())
            .or_default(),
    );
    lock.lock_owned().await
}

/// Run one git command in `dir`, returning its stdout.
pub(crate) async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    run(git_command(dir, args), args).await
}

/// `git` in `dir` that never waits on a prompt: nobody may be there to answer one.
fn git_command(dir: &str, args: &[&str]) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    command
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .no_console_window();
    command
}

/// A git command that talks to a remote: ssh asks nothing either, unless the user chose how git
/// runs ssh, and the command is killed if it hangs past `limit` regardless.
pub(crate) async fn git_remote(
    dir: &str,
    args: &[&str],
    limit: std::time::Duration,
) -> Result<String, String> {
    let mut command = git_command(dir, args);
    let user_chose = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || git(dir, &["config", "--get", "core.sshCommand"])
            .await
            .is_ok();
    if !user_chose {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    command.kill_on_drop(true);
    tokio::time::timeout(limit, run(command, args))
        .await
        .unwrap_or_else(|_| Err(format!("git {} timed out after {limit:?}", args.join(" "))))
}

async fn run(mut command: tokio::process::Command, args: &[&str]) -> Result<String, String> {
    let output = command
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

    let _adding = adding(project_path).await;
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

/// The namespace every branch Maestro makes for itself lives under. The app's
/// `list_prunable_branches` decides what it may delete from this prefix alone.
const MAESTRO_BRANCH_PREFIX: &str = "maestro/";

/// Where a task's worktree goes, relative to the repository root. The app's
/// `worktree_path_for_task`.
pub fn task_relative_path(task_id: i32) -> String {
    format!("{WORKTREE_DIR}/task-{task_id}")
}

/// Free text as a git-safe branch segment, exactly as the app's `slugifyName`: lowercase, runs of
/// anything but `a-z0-9` become one dash, cut at 50 and then trimmed of dashes, so it can be empty.
fn slugify_name(name: &str) -> String {
    let mut slug = String::new();
    for character in name.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.truncate(50);
    slug.trim_matches('-').to_string()
}

/// A task's branch, the app's `taskBranchName`: the id leads so branches sort and grep by task.
pub fn task_branch_name(task_id: i32, title: &str) -> String {
    format!("{MAESTRO_BRANCH_PREFIX}{task_id}-{}", slugify_name(title))
}

/// Where a task's session works, and what it was anchored at.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskWorkspace {
    /// Absolute directory the agent works in.
    pub cwd: String,
    /// The branch checked out there; `None` for the repository itself.
    pub branch: Option<String>,
    /// The worktree row the task owns; `None` for the repository itself.
    pub worktree_id: Option<i32>,
    /// The task's `execution_start_sha`, kept from an earlier run when it has one.
    pub start_sha: Option<String>,
}

/// A row's path made absolute: rows hold paths relative to the project.
pub(crate) fn absolute(project_path: &str, path: &str) -> String {
    if Path::new(path).is_absolute() {
        path.to_string()
    } else {
        format!("{project_path}/{path}")
    }
}

/// `git worktree add` for a task, returning the branch it landed on. The app's `create_worktree`:
/// with a new name, a branch cut from `base`; without, `base` checked out where it is, and a
/// remote branch with no local one of its name lands on a local tracking branch.
async fn add_task_worktree(
    project_path: &str,
    base: &str,
    relative: &str,
    new_branch: Option<&str>,
) -> Result<String, String> {
    if let Some(branch) = new_branch {
        git(
            project_path,
            &["worktree", "add", relative, "-b", branch, base],
        )
        .await?;
        return Ok(branch.to_string());
    }
    if let Some((_remote, local)) = base.split_once('/').filter(|(_, rest)| !rest.is_empty()) {
        let local_exists = verify(project_path, &format!("refs/heads/{base}")).await;
        if !local_exists && verify(project_path, &format!("refs/remotes/{base}")).await {
            git(
                project_path,
                &["worktree", "add", "--track", "-b", local, relative, base],
            )
            .await?;
            return Ok(local.to_string());
        }
    }
    git(project_path, &["worktree", "add", relative, base]).await?;
    Ok(base.to_string())
}

/// Whether `reference` names a commit.
async fn verify(project_path: &str, reference: &str) -> bool {
    git(
        project_path,
        &["rev-parse", "--verify", "--quiet", reference],
    )
    .await
    .is_ok_and(|out| !out.trim().is_empty())
}

/// Find or make the workspace a task's session runs in, and anchor the task's start sha.
///
/// As the app's `useExecuteTask` chooses: a refiner reads the repository and writes nothing, so it
/// runs there whatever the task says; every other role follows `workspace_mode`. The repository and
/// a pinned workspace create nothing on disk; a pinned one is claimed, so every "where does task N
/// work" query finds it through `task_id`. A new worktree is reused when the task already owns one.
///
/// Order, so a failure leaves no half state: git first, then the row, then the sha. A failed `git
/// worktree add` has written nothing. A failed insert removes the worktree it just made (and the
/// branch, when this call created it). A failed sha write leaves a worktree and a row the task
/// owns, which the next call reuses rather than duplicates. The store's lock is never held across
/// git, so a slow checkout does not stall every other request.
pub async fn prepare_task_workspace(
    store: &tokio::sync::Mutex<rusqlite::Connection>,
    task: &maestro_protocol::Task,
    role: maestro_protocol::AgentRole,
) -> Result<TaskWorkspace, String> {
    use crate::task_store::worktrees;
    use maestro_protocol::{
        AgentRole, BranchMode, ClaimWorktreeForTaskRequest, InsertWorktreeRequest, WorkspaceMode,
    };

    let project_path = task.project_path.as_str();
    let mode = if role == AgentRole::Refiner {
        WorkspaceMode::RepositoryDirectory
    } else {
        task.workspace_mode
    };

    let (cwd, branch, worktree_id) = match mode {
        WorkspaceMode::RepositoryDirectory => (project_path.to_string(), None, None),
        WorkspaceMode::ReuseWorkspace => {
            let worktree_id = task.workspace_worktree_id.ok_or_else(|| {
                "This task is pinned to no workspace. Pick one before running it.".to_string()
            })?;
            let claimed = worktrees::claim_for_task(
                &mut *store.lock().await,
                &ClaimWorktreeForTaskRequest {
                    project_path: project_path.to_string(),
                    task_id: task.id,
                    worktree_id,
                },
            )?;
            (
                absolute(project_path, &claimed.path),
                Some(claimed.branch_name),
                Some(claimed.id),
            )
        }
        WorkspaceMode::NewWorktree => {
            let owned = worktrees::list(&*store.lock().await, project_path, Some(task.id))?;
            if let Some(existing) = owned.into_iter().next() {
                (
                    absolute(project_path, &existing.path),
                    Some(existing.branch_name),
                    Some(existing.id),
                )
            } else {
                // Held through the row, so the next add in this repository sees it.
                let _adding = adding(project_path).await;
                if !is_repository(project_path).await {
                    return Err(
                        "This project is not a git repository, so worktrees are unavailable."
                            .to_string(),
                    );
                }
                tokio::fs::create_dir_all(Path::new(project_path).join(WORKTREE_DIR))
                    .await
                    .map_err(|e| format!("Failed to create worktree directory: {e}"))?;
                let relative = task_relative_path(task.id);
                let new_branch = match task.workspace_branch_mode {
                    BranchMode::Checkout => None,
                    BranchMode::Create => Some(
                        task.workspace_branch
                            .clone()
                            .filter(|b| !b.trim().is_empty())
                            .unwrap_or_else(|| task_branch_name(task.id, &task.title)),
                    ),
                };
                let base = match task.base_branch.trim() {
                    "" => "HEAD",
                    base => base,
                };
                let branch =
                    add_task_worktree(project_path, base, &relative, new_branch.as_deref()).await?;
                let inserted = worktrees::insert(
                    &*store.lock().await,
                    &InsertWorktreeRequest {
                        project_path: project_path.to_string(),
                        task_id: Some(task.id),
                        branch_name: branch.clone(),
                        base_branch: Some(task.base_branch.clone()),
                        path: relative.clone(),
                    },
                );
                let row = match inserted {
                    Ok(row) => row,
                    Err(e) => {
                        let _ =
                            git(project_path, &["worktree", "remove", &relative, "--force"]).await;
                        if new_branch.is_some() {
                            let _ = git(project_path, &["branch", "-D", &branch]).await;
                        }
                        return Err(e);
                    }
                };
                (
                    absolute(project_path, &relative),
                    Some(branch),
                    Some(row.id),
                )
            }
        }
    };

    // Best effort, as in the app: a session starts even when HEAD cannot be read. A task that
    // already has a sha keeps it, or a resumed run would hide everything the earlier one changed.
    let head = git(&cwd, &["rev-parse", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string());
    let stored = match head {
        Some(sha) => {
            crate::task_store::update(
                &mut *store.lock().await,
                project_path,
                task.id,
                &maestro_protocol::TaskUpdate {
                    execution_start_sha_if_empty: Some(sha),
                    ..Default::default()
                },
            )?
            .execution_start_sha
        }
        None => task.execution_start_sha.clone(),
    };

    Ok(TaskWorkspace {
        cwd,
        branch,
        worktree_id,
        start_sha: stored.filter(|sha| !sha.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_branch_matches_the_apps_name() {
        assert_eq!(slugify_name("Fix Windows Path"), "fix-windows-path");
        assert_eq!(slugify_name("feat: add  --  thing"), "feat-add-thing");
        assert_eq!(slugify_name("  !hello!  "), "hello");
        let long = slugify_name(&format!("{} tail", "a".repeat(49)));
        assert!(long.len() <= 50 && !long.ends_with('-'));
        assert_eq!(slugify_name("!!!"), "");
        assert_eq!(
            task_branch_name(12, "Fix Windows Path"),
            "maestro/12-fix-windows-path"
        );
        assert_eq!(task_branch_name(7, "add caching"), "maestro/7-add-caching");
        assert_eq!(task_branch_name(9, "!!!"), "maestro/9-");
        assert_eq!(task_relative_path(4), ".maestro/worktrees/task-4");
    }

    async fn repo_with_commit() -> tempfile::TempDir {
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
        repo
    }

    fn store_with_task(
        project: &str,
        title: &str,
        edit: impl FnOnce(&mut maestro_protocol::CreateTaskRequest),
    ) -> (
        tokio::sync::Mutex<rusqlite::Connection>,
        maestro_protocol::Task,
    ) {
        use maestro_protocol::{BranchMode, CreateTaskRequest, WorkspaceMode};
        let mut conn = crate::project_store::open_in_memory();
        let mut request = CreateTaskRequest {
            project_path: project.to_string(),
            title: title.to_string(),
            description: None,
            skills: vec![],
            labels: vec![],
            base_branch: "main".to_string(),
            agent_id: None,
            priority: None,
            auto_approve: false,
            workspace_mode: WorkspaceMode::NewWorktree,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            model_override: None,
        };
        edit(&mut request);
        let task = crate::task_store::create(&mut conn, &request).expect("create a task");
        (tokio::sync::Mutex::new(conn), task)
    }

    #[tokio::test]
    async fn a_task_gets_its_own_worktree_once() {
        use maestro_protocol::AgentRole;
        let repo = repo_with_commit().await;
        let project = repo.path().to_str().expect("utf-8 path");
        let (store, task) = store_with_task(project, "Fix Windows Path", |_| {});

        let first = prepare_task_workspace(&store, &task, AgentRole::Coder)
            .await
            .expect("prepare");
        let branch = format!("maestro/{}-fix-windows-path", task.id);
        assert_eq!(
            first.cwd,
            format!("{project}/.maestro/worktrees/task-{}", task.id)
        );
        assert_eq!(first.branch.as_deref(), Some(branch.as_str()));
        assert!(Path::new(&first.cwd).is_dir());
        let head = git(project, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(first.start_sha.as_deref(), Some(head.trim()));

        let again = prepare_task_workspace(&store, &task, AgentRole::Reviewer)
            .await
            .expect("reuse");
        assert_eq!(again, first);
        let rows = crate::task_store::worktrees::list(&*store.lock().await, project, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, Some(task.id));
    }

    #[tokio::test]
    async fn checkout_mode_lands_on_the_existing_branch() {
        use maestro_protocol::{AgentRole, BranchMode};
        let repo = repo_with_commit().await;
        let project = repo.path().to_str().expect("utf-8 path");
        git(project, &["branch", "feature"]).await.expect("branch");
        let (store, task) = store_with_task(project, "demo task", |r| {
            r.workspace_branch_mode = BranchMode::Checkout;
            r.base_branch = "feature".to_string();
        });

        let workspace = prepare_task_workspace(&store, &task, AgentRole::Coder)
            .await
            .expect("prepare");
        assert_eq!(workspace.branch.as_deref(), Some("feature"));
        let checked_out = git(&workspace.cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap();
        assert_eq!(checked_out.trim(), "feature");
    }

    #[tokio::test]
    async fn the_repository_and_a_refiner_create_nothing() {
        use maestro_protocol::{AgentRole, WorkspaceMode};
        let repo = repo_with_commit().await;
        let project = repo.path().to_str().expect("utf-8 path");
        let (store, repository_task) = store_with_task(project, "demo task", |r| {
            r.workspace_mode = WorkspaceMode::RepositoryDirectory;
        });
        let in_repo = prepare_task_workspace(&store, &repository_task, AgentRole::Coder)
            .await
            .expect("prepare");
        assert_eq!(in_repo.cwd, project);
        assert_eq!((in_repo.branch, in_repo.worktree_id), (None, None));
        assert!(in_repo.start_sha.is_some());

        let (store, worktree_task) = store_with_task(project, "demo task", |_| {});
        let refiner = prepare_task_workspace(&store, &worktree_task, AgentRole::Refiner)
            .await
            .expect("prepare");
        assert_eq!(refiner.cwd, project);
        assert!(!Path::new(project).join(WORKTREE_DIR).exists());
        assert!(
            crate::task_store::worktrees::list(&*store.lock().await, project, None)
                .unwrap()
                .is_empty()
        );
    }

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
