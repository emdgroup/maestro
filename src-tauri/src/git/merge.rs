use super::exec::{run_git_in_dir, run_git_in_dir_lossy};
use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::{get_project_with_git_conn, AppState};
use crate::git::worktree_lifecycle::{delete_worktree_rows, task_worktree};
use crate::models::{GitConnection, MergeResult, PullRequestCi, Task, TaskBall};
use crate::task::crud::{get_task_on_server, update_task_on_server};
use crate::task::ops::{apply_transition_on_server, apply_transition_writing};
use maestro_protocol::{
    NewTaskComment, ProjectRef, SaveTaskReviewRequest, TaskTransition, TaskUpdate, TransitionGuard,
};
use std::sync::Arc;
use tauri::State;

/// A task of the project, or an error naming it.
async fn require_task(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<Task, String> {
    get_task_on_server(app_state, project_id, task_id)
        .await?
        .ok_or_else(|| format!("Task {} not found", task_id))
}

/// Squash merge a task branch into main using native Rust subprocess calls.
///
/// This function operates on the local repo path (worktrees are always local even
/// for remote projects). It is NOT dispatched through GitConnection because squash
/// merge targets the local main branch, not a remote path.
///
/// Steps:
/// 1. Checkout main
/// 2. git merge <branch> --squash --no-commit
/// 3. git status --porcelain to detect conflicts
///    4a. If conflicts: abort merge, return conflict list
///    4b. If nothing staged: return error (branches identical)
/// 5. Commit with standardised message
pub async fn squash_merge_to_base(
    conn: &GitConnection,
    branch_name: &str,
    target_branch: &str,
    commit_message: &str,
) -> Result<MergeResult, String> {
    let repo_path = conn.path();

    run_git_in_dir(conn, repo_path, &["checkout", target_branch])
        .await
        .map_err(|e| format!("git checkout {} failed: {}", target_branch, e))?;

    // A non-zero exit is the expected outcome on conflicts, so the result is read from the
    // working tree below rather than from the status of this call.
    let _ = run_git_in_dir_lossy(
        conn,
        repo_path,
        &["merge", branch_name, "--squash", "--no-commit"],
    )
    .await;

    let status_stdout = run_git_in_dir(conn, repo_path, &["status", "--porcelain"])
        .await
        .map_err(|e| format!("git status failed: {}", e))?;
    let conflicts = parse_conflict_files(&status_stdout);

    // Squash merges don't create MERGE_HEAD so `merge --abort` is a no-op here;
    // `reset --hard HEAD` is the correct way to restore the index and working tree.
    if !conflicts.is_empty() {
        let _ = run_git_in_dir_lossy(conn, repo_path, &["reset", "--hard", "HEAD"]).await;
        return Ok(MergeResult {
            success: false,
            task_status: "InProgress".to_string(),
            conflicts,
            pull_request_url: None,
        });
    }

    // Nothing staged means the branches may already be identical. `diff --cached` rather than the
    // porcelain status above, which also counts pre-existing unstaged modifications and would
    // report content to merge where there is none.
    let staged_output = run_git_in_dir(conn, repo_path, &["diff", "--cached", "--name-only"])
        .await
        .map_err(|e| format!("git diff --cached failed: {}", e))?;

    if staged_output.trim().is_empty() {
        return Err(format!(
            "Nothing to merge: no changes between {} and {}",
            branch_name, target_branch
        ));
    }

    run_git_in_dir(
        conn,
        repo_path,
        &["commit", "--no-verify", "-m", commit_message],
    )
    .await
    .map_err(|e| format!("git commit failed: {}", e))?;

    Ok(MergeResult {
        success: true,
        task_status: "Done".to_string(),
        conflicts: vec![],
        pull_request_url: None,
    })
}

/// Parse `git status --porcelain` output for merge conflict markers.
///
/// Conflict XY codes: any line where X or Y is 'U' (unmerged), plus 'AA' (both added)
/// and 'DD' (both deleted). Returns a list of conflicting file paths.
fn parse_conflict_files(porcelain_status: &str) -> Vec<String> {
    porcelain_status
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let xy = &line[..2];
            // Conflict XY codes: any line where X or Y is 'U', plus AA and DD
            let is_conflict = xy.contains('U') || xy == "AA" || xy == "DD";
            if is_conflict {
                Some(line[3..].to_string())
            } else {
                None
            }
        })
        .collect()
}

// ============================================================================
// Merge automation and conflict handling (from review_handlers)
// ============================================================================

const DEFAULT_COMMIT_TEMPLATE: &str = "\
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.";

/// A task running without an isolated worktree has no branch of its own — the agent committed
/// straight onto whatever the project was already on — so the merge wording above would describe
/// something that never happens.
const DEFAULT_COMMIT_TEMPLATE_IN_PLACE: &str = "Task #{task_id}: {task_name}";

fn resolve_template(
    template: &str,
    task_id: i32,
    task_name: &str,
    branch: &str,
    target_branch: &str,
    external_id: &str,
    description: &str,
) -> String {
    template
        .replace("{task_id}", &task_id.to_string())
        .replace("{task_name}", task_name)
        .replace("{branch}", branch)
        .replace("{target_branch}", target_branch)
        .replace("{external_id}", external_id)
        .replace("{description}", description)
}

/// Resolve the commit message template for a task.
/// Reads .maestro/commit-template.txt from the project path; falls back to the default template.
/// Returns the resolved string with all variables substituted.
#[tauri::command]
#[specta::specta]
pub async fn resolve_commit_message(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<String, String> {
    // A task running in the repository directory has no worktree, and that is not an error: it
    // used to be, which left the approve dialog with an empty commit message and its confirm
    // button permanently disabled.
    let task = require_task(&app_state, project_id, task_id).await?;
    let branch_name = task_worktree(&app_state, project_id, task_id)
        .await?
        .map(|worktree| worktree.branch_name);
    let project = crate::project::lock::load_project(&app_state, project_id)?;
    let (task_name, base_branch, external_id, description, project_path) = (
        task.title,
        task.base_branch,
        task.external_id,
        task.description,
        project.path,
    );
    let connection_key = ConnectionKey::from_all_ids(
        project.connection_id,
        project.wsl_connection_id,
        project.docker_connection_id,
    );

    let default_template = match branch_name {
        Some(_) => DEFAULT_COMMIT_TEMPLATE,
        None => DEFAULT_COMMIT_TEMPLATE_IN_PLACE,
    };
    // With no worktree there is no branch of the task's own, so `{branch}` names the branch the
    // work actually landed on.
    let branch_name = branch_name.unwrap_or_else(|| base_branch.clone());

    // A project that never customised its template has no file, which is not an error.
    let template_path = format!("{}/.maestro/commit-template.txt", project_path);
    let template =
        match crate::core::git_connection_for(&app_state, project_path.clone(), connection_key)
            .await
        {
            Ok(conn) => crate::connectivity::files::read_text(&conn, &template_path)
                .await
                .unwrap_or_else(|_| default_template.to_string()),
            Err(_) => default_template.to_string(),
        };

    let external_id_str = external_id.unwrap_or_default();
    let description_str = description
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    Ok(resolve_template(
        &template,
        task_id,
        &task_name,
        &branch_name,
        &base_branch,
        &external_id_str,
        &description_str,
    ))
}

/// Approve task and perform synchronous merge to main branch
///
/// Orchestrates the complete merge workflow synchronously:
/// 1. Queries task details and worktree info
/// 2. Calls native Rust squash merge via git subprocess (awaits completion)
/// 3. On success: updates task to "Done", cleans up worktree, returns to pool
/// 4. On conflict: rejects task back to "InProgress", saves conflict feedback
///
/// Returns a typed MergeResult with success flag, task_status, and conflicts.
#[tauri::command]
#[specta::specta]
pub async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    merge_strategy: String,
    include_untracked: bool,
    commit_message: String,
) -> Result<MergeResult, String> {
    // A task running in the repository directory has no worktree; see the refusal below for why
    // that is caught there rather than here.
    let task = require_task(&app_state, project_id, task_id).await?;
    let worktree = task_worktree(&app_state, project_id, task_id)
        .await?
        .map(|worktree| (worktree.branch_name, worktree.path, worktree.id));
    let base_branch = task.base_branch.clone();

    let (project, git_conn) = get_project_with_git_conn(app_state.inner(), project_id)
        .await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;
    let repo_path = project.path;

    // A task based on a remote ref stores `origin/main`, which is the right thing to *branch from*
    // but never the right thing to merge into: `git checkout origin/main` detaches HEAD, and no
    // forge has a branch by that name to open a pull request against. Both consumers below take
    // this value, so normalising once here covers them.
    let base_branch = match crate::git::local_branch_for(&git_conn, &base_branch).await {
        Some(local) => local,
        None => base_branch,
    };

    // 3. The agent's work lives in its worktree, and there is no other place it can be.
    //
    // Worktrees are enforced wherever git is available and Review exists only for git projects,
    // so a task that reaches here without one is a corrupted row — most likely a worktree
    // deletion that failed silently after an earlier merge, which `finalize_successful_merge`
    // swallows by design. Falling back to the project root, as this used to, would stage and
    // commit whatever happened to be dirty in the user's checkout under this task's commit
    // message. Refusing is the only safe answer.
    let Some((branch_name, worktree_rel_path, worktree_id)) = worktree else {
        return Err(format!(
            "Task {} is in review but has no worktree on record, so there is nothing safe to \
             commit. Re-run the task rather than approving it.",
            task_id
        ));
    };

    let full_worktree_path = format!("{}/{}", repo_path, worktree_rel_path);

    // 3a. Stage and commit modified tracked files (agents may modify without committing)
    run_git_in_dir(&git_conn, &full_worktree_path, &["add", "-u"])
        .await
        .map_err(|e| format!("Failed to stage modified files: {}", e))?;

    // 3b. Also stage untracked files if user opted in
    if include_untracked {
        let untracked_output = run_git_in_dir(
            &git_conn,
            &full_worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        )
        .await
        .unwrap_or_default();

        let untracked_files: Vec<&str> = untracked_output
            .lines()
            .filter(|line| !line.is_empty())
            .collect();

        if !untracked_files.is_empty() {
            let mut add_args = vec!["add", "--"];
            add_args.extend(untracked_files.iter().copied());
            run_git_in_dir(&git_conn, &full_worktree_path, &add_args)
                .await
                .map_err(|e| format!("Failed to stage untracked files: {}", e))?;
        }
    }

    // 3c. Commit everything staged (modified + untracked if included)
    let staged_output = run_git_in_dir(
        &git_conn,
        &full_worktree_path,
        &["diff", "--cached", "--name-only"],
    )
    .await
    .unwrap_or_default();

    if !staged_output.trim().is_empty() {
        run_git_in_dir(
            &git_conn,
            &full_worktree_path,
            &["commit", "--no-verify", "-m", &commit_message],
        )
        .await
        .map_err(|e| format!("Failed to commit changes: {}", e))?;
    }

    // Push before landing, so a push that fails leaves the task in Review rather than reporting
    // Done for work that never left the machine.
    if merge_strategy == "CommitAndPush" {
        let status = crate::integration::code_hosting_handlers::code_hosting_status(
            app_state.inner(),
            project_id,
        )
        .await?;
        let Some(remote) = status.remote else {
            return Err(
                "This project has no git remote, so there is nothing to push to.".to_string(),
            );
        };
        crate::git::push_branch(&git_conn, &full_worktree_path, &remote, &branch_name).await?;
    }

    // The one approve path that does not land the task: the work reaches the base branch when
    // somebody merges the PR, and that somebody is not Maestro. Everything else about the task is
    // therefore left standing — worktree on disk, branch alive — until G3 hears back from the forge.
    if merge_strategy == "CreatePullRequest" {
        let url = open_pull_request_for_task(
            app_state.inner(),
            &task,
            &git_conn,
            &full_worktree_path,
            &branch_name,
            &base_branch,
        )
        .await?;
        return Ok(MergeResult {
            success: true,
            task_status: "Review".to_string(),
            conflicts: vec![],
            pull_request_url: Some(url),
        });
    }

    // Commit-only leaves the branch unmerged and the worktree on disk, but still lands the task —
    // this used to return without writing any status, so an approved task stayed in Review looking
    // exactly like one nobody had looked at yet. A pushed branch lands the same way: it is on the
    // remote but still unmerged, which is what `ApprovedWithoutMerge` already means.
    if merge_strategy == "CommitOnly" || merge_strategy == "CommitAndPush" {
        apply_transition_on_server(
            app_state.inner(),
            project_id,
            task_id,
            TaskTransition::ApprovedWithoutMerge,
            TransitionGuard::Always,
        )
        .await?;
        return Ok(MergeResult {
            success: true,
            task_status: "Done".to_string(),
            conflicts: vec![],
            pull_request_url: None,
        });
    }

    // 4. Perform squash merge via git dispatcher (local, SSH, or WSL)
    let merge_result =
        squash_merge_to_base(&git_conn, &branch_name, &base_branch, &commit_message).await?;

    if merge_result.success {
        // 4a. Merge succeeded - finalize (mark Done, cleanup worktree)
        finalize_successful_merge(
            app_state.inner(),
            project_id,
            task_id,
            worktree_id,
            &full_worktree_path,
            &branch_name,
            TaskTransition::Merged,
        )
        .await?;
        Ok(MergeResult {
            success: true,
            task_status: "Done".to_string(),
            conflicts: vec![],
            pull_request_url: None,
        })
    } else if !merge_result.conflicts.is_empty() {
        // 4b. Merge had conflicts - reject back to InProgress
        reject_merge_on_conflict(
            app_state.inner(),
            project_id,
            task_id,
            &merge_result.conflicts,
        )
        .await?;
        Ok(merge_result)
    } else {
        // 4c. Merge reported failure without conflicts - return error
        Err("Merge failed with unknown error".to_string())
    }
}

/// Push the task's branch, open a pull request for it, and record both facts.
///
/// Ordered so that nothing is written until the forge has actually accepted the PR. A task
/// recorded as `AwaitingMerge` with no pull request behind it would sit on the board waiting for
/// an event that can never arrive, which is worse than an error the user can read and retry.
///
/// Returns the PR's URL.
async fn open_pull_request_for_task(
    app_state: &Arc<AppState>,
    task: &Task,
    git_conn: &GitConnection,
    worktree_path: &str,
    branch_name: &str,
    base_branch: &str,
) -> Result<String, String> {
    use crate::integration::code_hosting_handlers::{code_hosting_status, CodeHostingRung};
    use crate::integration::issue_tracking_handlers::find_integration;
    use crate::integration::pull_request::{
        create_pull_request, preferred_credential_base, supports_pull_requests, PullRequestTarget,
    };

    let (project_id, task_id) = (task.project_id, task.id);
    let status = code_hosting_status(app_state, project_id).await?;
    let (Some(remote), Some(config)) = (status.remote, status.config) else {
        return Err(match status.rung {
            CodeHostingRung::NoRemote => {
                "This project has no git remote, so there is nowhere to open a pull request."
                    .to_string()
            }
            _ => "This project's remote is not on a forge Maestro recognises. Push the branch \
                  and open the pull request yourself, or merge locally."
                .to_string(),
        });
    };

    // Asked here rather than trusted from the config, because a credential can come from the
    // `gh` CLI with no integration stored and can expire between one approve and the next.
    let integration = find_integration(
        &config.provider,
        &config.host,
        preferred_credential_base(&config).as_deref(),
        app_state,
    )
    .await
    .ok_or_else(|| {
        format!(
            "No {} credentials are available, so the pull request cannot be opened. Connect \
                 {} in Settings, or push the branch and open it yourself.",
            config.provider, config.provider
        )
    })?;

    // Asked before the push rather than left to `create_pull_request` below. Both refuse the same
    // forges, but by the time that one answers the branch is already on the remote with nothing
    // going to open a pull request for it. The UI gate cannot stand in for this: a stale query
    // cache is enough to reach here with an option that was never valid.
    if !supports_pull_requests(&config) {
        return Err(format!(
            "Maestro cannot open pull requests on `{}` yet. Push the branch and open it yourself, \
             or merge locally.",
            config.provider
        ));
    }

    // The branch has to exist on the remote before the forge will accept a PR for it.
    crate::git::push_branch(git_conn, worktree_path, &remote, branch_name).await?;

    let created = create_pull_request(
        &PullRequestTarget {
            config: &config,
            instance_url: integration.instance_url.as_deref(),
            token: &integration.token,
        },
        branch_name,
        base_branch,
        &task.title,
        task.description.as_deref().unwrap_or(""),
    )
    .await?;

    // One request, so the task is never at `AwaitingMerge` without its pull request on record.
    // `pull_request_ci` is cleared alongside, or a second pull request on the same task would
    // inherit the first one's verdict until the next sweep overwrote it.
    apply_transition_writing(
        app_state,
        project_id,
        task_id,
        TaskTransition::PullRequestOpened,
        TransitionGuard::Always,
        Some(TaskUpdate {
            pull_request_url: Some(created.url.clone()),
            pull_request_number: Some(created.number),
            pull_request_ci: Some(None),
            ..Default::default()
        }),
        None,
    )
    .await
    .map_err(|e| format!("Failed to record the pull request: {}", e))?;

    log::info!("Opened pull request {} for task {}", created.url, task_id);
    Ok(created.url)
}

/// Ask the forge what became of every pull request this project is waiting on, and act on it.
///
/// Runs on project open as well as on a timer, and that is the whole of "offline reconciliation":
/// the forge is asked for current state rather than for events, so an app that was closed when a
/// pull request merged learns exactly what a running one would have. Nothing to replay, no
/// webhook to miss.
///
/// Returns the ids of the tasks whose state changed — which includes a task whose only change was
/// the cached CI verdict, because the card shows that and the caller's refetch is keyed on this
/// list being non-empty.
///
/// Every failure here is a warning rather than an error. A rate limit, an expired token or a
/// dropped connection means "ask again in a few minutes", and turning that into a red card would
/// make the network's health look like the task's.
#[tauri::command]
#[specta::specta]
pub async fn reconcile_pull_requests(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<i32>, String> {
    use crate::integration::code_hosting_handlers::code_hosting_status;
    use crate::integration::issue_tracking_handlers::find_integration;
    use crate::integration::pull_request::{
        fetch_ci_state, fetch_pull_request, preferred_credential_base, CiState, PullRequestState,
        PullRequestTarget,
    };

    let waiting: Vec<(i32, i64)> = query_project_store(
        &app_state,
        project_id,
        |project_path| ServerRequest::ListTasksAwaitingMerge(ProjectRef { project_path }),
        reply!(ServerResponse::ListTasksAwaitingMergeOk(list) => list.tasks),
    )
    .await
    .map_err(|e| format!("Failed to query tasks awaiting merge: {}", e))?
    .into_iter()
    .filter_map(|task| Some((task.id, task.pull_request_number?)))
    .collect();

    if waiting.is_empty() {
        return Ok(vec![]);
    }

    // Resolved once for the whole sweep rather than per task: every one of these pull requests is
    // on the same project's remote, and a token probe can spawn the `gh` CLI.
    let status = code_hosting_status(app_state.inner(), project_id).await?;
    let Some(config) = status.config else {
        return Ok(vec![]);
    };
    let Some(integration) = find_integration(
        &config.provider,
        &config.host,
        preferred_credential_base(&config).as_deref(),
        app_state.inner(),
    )
    .await
    else {
        log::debug!(
            "Cannot reconcile pull requests for project {}: no {} credentials",
            project_id,
            config.provider
        );
        return Ok(vec![]);
    };

    let target = PullRequestTarget {
        config: &config,
        instance_url: integration.instance_url.as_deref(),
        token: &integration.token,
    };

    // Asked for all at once rather than one after another. This is the sweep's only unconditional
    // request per task, it runs every three minutes over every open pull request in the project,
    // and each one is independent — serialised, the sweep cost one network round trip per task.
    //
    // Only the reads fan out. The decisions below stay on this thread, in the order the tasks came
    // out of the database, so that concurrency cannot reorder a transition against another.
    let lookups: Vec<_> = waiting
        .iter()
        .map(|&(task_id, number)| {
            let config = config.clone();
            let instance_url = integration.instance_url.clone();
            let token = integration.token.clone();
            tokio::spawn(async move {
                let target = PullRequestTarget {
                    config: &config,
                    instance_url: instance_url.as_deref(),
                    token: &token,
                };
                (task_id, number, fetch_pull_request(&target, number).await)
            })
        })
        .collect();

    let mut fetched = Vec::with_capacity(lookups.len());
    for lookup in lookups {
        match lookup.await {
            Ok(result) => fetched.push(result),
            // The task panicked or was cancelled. Nothing is known about that pull request, which
            // is the same position a failed request leaves us in: try again on the next sweep.
            Err(e) => log::warn!("A pull request lookup did not finish: {}", e),
        }
    }

    let mut changed = Vec::new();
    for (task_id, number, lookup) in fetched {
        let details = match lookup {
            Ok(details) => details,
            Err(e) => {
                log::warn!(
                    "Could not read pull request #{} for task {}: {}",
                    number,
                    task_id,
                    e
                );
                continue;
            }
        };

        match details.state {
            PullRequestState::Open => {
                // Read again rather than taken from the list above: the lookups took a network
                // round trip, and a coder may have picked the task up meanwhile.
                let Some(task) = get_task_on_server(&app_state, project_id, task_id).await? else {
                    continue;
                };

                // The forge only moves a task nobody is holding. A conflict surfacing while a
                // CI-fix coder is mid-turn would take the session's task out from under it, and
                // that turn ends in a push the next sweep should be reading anyway.
                if task.ball == TaskBall::External && details.mergeable == Some(false) {
                    // Guarded on the ball read above: a coder may have claimed the task since.
                    if apply_transition_on_server(
                        &app_state,
                        project_id,
                        task_id,
                        TaskTransition::PullRequestConflicted,
                        TransitionGuard::Ball(maestro_protocol::TaskBall::External),
                    )
                    .await?
                    .is_none()
                    {
                        continue;
                    }
                    log::info!(
                        "Pull request #{} conflicts; task {} needs a rebase",
                        number,
                        task_id
                    );
                    changed.push(task_id);
                    // CI is not asked. Fixing a build on a branch that cannot merge spends a round
                    // on work the rebase will invalidate, and `request_ci_fix` would refuse it
                    // anyway now that the ball has moved.
                    continue;
                }

                // `AwaitingMerge` + `Waiting` + the ball on the user is a conflict this sweep
                // raised and nothing else, so the ball alone is the flag. Only `Some(true)` clears
                // it: `None` is the forge still computing the merge commit, and treating that as
                // resolved would hand the task back with the conflict still in it.
                if task.ball == TaskBall::User {
                    if details.mergeable != Some(true) {
                        continue;
                    }
                    // Guarded on the ball read above: a coder may have claimed the task since.
                    if apply_transition_on_server(
                        &app_state,
                        project_id,
                        task_id,
                        TaskTransition::PullRequestMergeable,
                        TransitionGuard::Ball(maestro_protocol::TaskBall::User),
                    )
                    .await?
                    .is_none()
                    {
                        continue;
                    }
                    log::info!(
                        "Pull request #{} merges again; task {} is back with the forge",
                        number,
                        task_id
                    );
                    changed.push(task_id);
                }

                let ci = match fetch_ci_state(&target, number, details.head_sha.as_deref()).await {
                    Ok(ci) => ci,
                    Err(e) => {
                        log::warn!("Could not read CI for pull request #{}: {}", number, e);
                        continue;
                    }
                };

                // Screened against the row read above so that a spent loop costs no request every
                // sweep; the daemon checks the same under its lock before it writes anything.
                let fixing = match &ci {
                    CiState::Failing(checks)
                        if task.ball == TaskBall::External && task.fix_rounds < FIX_ROUND_CAP =>
                    {
                        request_ci_fix(&app_state, project_id, task_id, number, checks).await?
                    }
                    _ => false,
                };
                let recorded = record_pull_request_ci(&app_state, &task, cached_ci(&ci)).await?;
                let touched = fixing || recorded;
                if touched && changed.last() != Some(&task_id) {
                    changed.push(task_id);
                }
            }
            PullRequestState::Merged => {
                if let Err(e) =
                    land_merged_pull_request(app_state.inner(), project_id, task_id).await
                {
                    log::warn!(
                        "Pull request #{} merged but task {} could not land: {}",
                        number,
                        task_id,
                        e
                    );
                    continue;
                }
                changed.push(task_id);
            }
            // Unlike a merge, this leaves the task in `AwaitingMerge` — deliberately, since a
            // closed pull request is a decision for the user and not a route anywhere. That keeps
            // the task in this sweep's candidate set for as long as it sits there, so the write has
            // to be conditional or every three minutes would re-decide it: bumping `updated_at`,
            // repeating the log line, and refetching the whole board through `changed`.
            PullRequestState::Closed => {
                let news = apply_transition_on_server(
                    &app_state,
                    project_id,
                    task_id,
                    TaskTransition::PullRequestClosed,
                    TransitionGuard::Changed,
                )
                .await?
                .is_some();
                if news {
                    log::info!(
                        "Pull request #{} was closed without merging; task {} needs a decision",
                        number,
                        task_id
                    );
                    changed.push(task_id);
                }
            }
        }
    }

    Ok(changed)
}

/// How many times an agent may be sent to fix a task's CI before the user has to look.
///
/// Same reasoning as the review loop's cap, with more at stake: this one pushes commits to a pull
/// request other people can see. A build that is red for a reason the agent cannot fix — a missing
/// secret, a flaky runner, an infrastructure outage — stays red however many times it tries.
pub const FIX_ROUND_CAP: i32 = 3;

/// What of a `CiState` is worth caching on the task.
///
/// `Unknown` has no entry: "no CI configured" and "the forge would not say" are the same silence on
/// the card as "not swept yet", so a variant for them would render identically to their absence.
fn cached_ci(ci: &crate::integration::pull_request::CiState) -> Option<PullRequestCi> {
    use crate::integration::pull_request::CiState;
    match ci {
        CiState::Passing => Some(PullRequestCi::Passing),
        CiState::Failing(_) => Some(PullRequestCi::Failing),
        CiState::Pending => Some(PullRequestCi::Pending),
        CiState::Unknown => None,
    }
}

/// Cache what CI last said, and report whether that was news.
///
/// Compared before writing rather than written blind, because the sweep runs every three minutes
/// against every open pull request and its caller turns "something changed" into a board-wide
/// refetch. `updated_at` is deliberately untouched: a poll is not an edit to the task.
async fn record_pull_request_ci(
    app_state: &Arc<AppState>,
    task: &Task,
    ci: Option<PullRequestCi>,
) -> Result<bool, String> {
    if !ci_is_news(task.pull_request_ci, ci) {
        return Ok(false);
    }
    update_task_on_server(
        app_state,
        task.project_id,
        task.id,
        TaskUpdate {
            pull_request_ci: Some(ci.map(Into::into)),
            ..Default::default()
        },
    )
    .await
    .map_err(|e| format!("Could not record CI for task {}: {}", task.id, e))?;
    Ok(true)
}

/// Whether CI said something the task does not already hold. `stored` has been through the daemon
/// and back, so this is only as good as that round trip.
fn ci_is_news(stored: Option<PullRequestCi>, seen: Option<PullRequestCi>) -> bool {
    stored != seen
}

/// Send an agent to fix a red build, if the loop has rounds left, and report whether one was sent.
///
/// The caller has already established that CI finished and failed. Pending, passing, absent and
/// unreadable never reach here, because the only thing this does is start an agent that pushes
/// commits to an open pull request, and every unclear case resolves itself on the next sweep.
///
/// One request under [`TransitionGuard::FixRoundsBelow`]: the round is counted, the report filed and
/// the coder sent only while the ball is still with the forge and rounds remain, so a refusal counts
/// nothing and reports nothing.
async fn request_ci_fix(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    number: i64,
    checks: &[String],
) -> Result<bool, String> {
    // The failing checks go in the outcome thread rather than into a prompt from here, because the
    // agent is started by the frontend and this is the same route the reviewer's findings take.
    let report = format!(
        "CI failed on pull request #{}. Failing checks:\n\n{}",
        number,
        checks
            .iter()
            .map(|check| format!("- {}", check))
            .collect::<Vec<_>>()
            .join("\n")
    );

    let sent = apply_transition_writing(
        app_state,
        project_id,
        task_id,
        TaskTransition::CiFixRequested,
        TransitionGuard::FixRoundsBelow(FIX_ROUND_CAP),
        Some(TaskUpdate {
            increment_fix_rounds: true,
            ..Default::default()
        }),
        Some(NewTaskComment {
            kind: "ci".to_string(),
            author: "maestro".to_string(),
            body: Some(report),
            external_ref: None,
            phase: Some("AwaitingMerge".to_string()),
        }),
    )
    .await?;

    let Some(task) = sent else {
        return Ok(false);
    };
    log::info!(
        "CI failed on pull request #{} for task {} ({}); sending an agent (round {} of {})",
        number,
        task_id,
        checks.join(", "),
        task.fix_rounds,
        FIX_ROUND_CAP
    );
    Ok(true)
}

/// Push the fixing agent's work to the pull request it belongs to and hand the task back to the
/// forge.
///
/// Called when a turn ends at `AwaitingMerge`. A push that fails leaves the task where it is with
/// the ball still on the agent, which the next sweep will not re-trigger — the user has to look,
/// which is right, because a fix that cannot be pushed is not a fix.
pub(crate) async fn push_ci_fix(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    let worktree = task_worktree(app_state, project_id, task_id)
        .await?
        .ok_or_else(|| format!("No worktree for task {}", task_id))?;

    let (project, git_conn) = get_project_with_git_conn(app_state, project_id).await?;
    let status =
        crate::integration::code_hosting_handlers::code_hosting_status(app_state, project_id)
            .await?;
    let remote = status
        .remote
        .ok_or_else(|| "The project has no remote to push to".to_string())?;

    crate::git::push_branch(
        &git_conn,
        &format!("{}/{}", project.path, worktree.path),
        &remote,
        &worktree.branch_name,
    )
    .await?;

    // The verdict that triggered the fix must not outlive the fix: the card would keep reading
    // `Failing` for a build that is re-running, and the poll would see nothing unreported and stay
    // at its steady rate instead of sweeping for the new run.
    apply_transition_writing(
        app_state,
        project_id,
        task_id,
        TaskTransition::CiFixPushed,
        TransitionGuard::Always,
        Some(TaskUpdate {
            pull_request_ci: Some(None),
            ..Default::default()
        }),
        None,
    )
    .await
    .map(|_| ())
}

/// Land a task whose pull request merged: Done with the `MergedViaPR` qualifier, worktree and
/// branch cleaned up.
///
/// The branch is deleted locally only. Whether the *remote* branch goes is the forge's setting,
/// not ours — deleting it here would override a repository that keeps merged branches.
async fn land_merged_pull_request(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    // A task can reach here with no worktree row — the user may have removed it while the PR was
    // open. The merge still happened, so the task still lands; there is simply nothing to clean up.
    let Some(worktree) = task_worktree(app_state, project_id, task_id).await? else {
        return apply_transition_on_server(
            app_state,
            project_id,
            task_id,
            TaskTransition::PullRequestMerged,
            TransitionGuard::Always,
        )
        .await
        .map(|_| ());
    };
    let project = crate::project::lock::load_project(app_state, project_id)?;

    finalize_successful_merge(
        app_state,
        project_id,
        task_id,
        worktree.id,
        &format!("{}/{}", project.path, worktree.path),
        &worktree.branch_name,
        TaskTransition::PullRequestMerged,
    )
    .await
}

/// Finalize successful merge: update task to Done, cleanup worktree from disk, delete from DB
///
/// Helper function (private crate-level) called after successful merge to perform cleanup:
/// 1. Updates task status to Done
/// 2. Deletes worktree from disk via Rust git dispatcher
/// 3. Removes worktree from database on successful cleanup
///
/// `landed` says *how* it merged — locally, or through a pull request somebody else merged — so
/// the Done card can tell the two apart. Everything after that write is identical.
pub(crate) async fn finalize_successful_merge(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    worktree_id: i32,
    worktree_path: &str,
    branch_name: &str,
    landed: TaskTransition,
) -> Result<(), String> {
    // The task lands before its worktree goes: removing the worktree is git work in between, and
    // a crash there leaves a row `cleanup_zombie_worktrees` recovers.
    apply_transition_on_server(
        app_state,
        project_id,
        task_id,
        landed,
        TransitionGuard::Always,
    )
    .await?;

    let (_project, git_conn) = get_project_with_git_conn(app_state, project_id)
        .await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    match crate::git::delete_worktree(&git_conn, worktree_path).await {
        Ok(()) => {
            // Best effort, but not silent: this refused once after a squash merge and left the
            // branch behind, and because the error went nowhere the only way to notice was to
            // compare the repository against what this function claims to do. git's own message is
            // the diagnosis, so it has to reach the log.
            if let Err(e) =
                run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-D", branch_name]).await
            {
                log::warn!(
                    "Merged task {} but could not delete branch {}: {}",
                    task_id,
                    branch_name,
                    e
                );
            }
            delete_worktree_rows(app_state, project_id, vec![worktree_id])
                .await
                .map_err(|e| format!("Failed to delete worktree from DB: {}", e))?;
        }
        // Left for `cleanup_zombie_worktrees` to retry, which is why this is not an error — but a
        // retry that keeps failing is indistinguishable from one that never ran unless it says so.
        Err(e) => {
            log::warn!(
                "Merged task {} but could not remove worktree {}: {}",
                task_id,
                worktree_path,
                e
            );
        }
    }

    Ok(())
}

/// Reject a merge and move task back to InProgress with conflict feedback
///
/// Called when merge conflicts are detected:
/// 1. Records a RequestChanges review with formatted conflict feedback
/// 2. Updates task status back to InProgress for the agent to rework
///
/// The review is updated in place rather than replaced: by the time a merge conflict is reported
/// the approve flow has already written an `Approve` review, and replacing it would take the
/// user's per-file comments with it.
pub(crate) async fn reject_merge_on_conflict(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    conflicts: &[String],
) -> Result<(), String> {
    let conflict_feedback = format!("Merge conflict detected:\n{}", conflicts.join("\n"));

    // The review first: a Rework task without its conflict list sends a coder in blind, while a
    // saved list on a task the transition then failed to move is only read once it does move.
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::SaveTaskReview(SaveTaskReviewRequest {
                project_path,
                task_id,
                decision: "RequestChanges".to_string(),
                general_feedback: Some(conflict_feedback),
                comments: None,
            })
        },
        reply!(ServerResponse::SaveTaskReviewOk(_) => ()),
    )
    .await
    .map_err(|e| format!("Save feedback failed: {}", e))?;

    apply_transition_on_server(
        app_state,
        project_id,
        task_id,
        TaskTransition::MergeConflict,
        TransitionGuard::Always,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    /// A settled pull request, CI saying what the task already holds, is no news: otherwise every
    /// sweep would refetch the whole board for every open pull request.
    #[test]
    fn ci_the_task_already_holds_is_no_news() {
        use crate::integration::pull_request::CiState;
        for state in [
            CiState::Passing,
            CiState::Failing(vec!["build".to_string()]),
            CiState::Pending,
            CiState::Unknown,
        ] {
            let seen = cached_ci(&state);
            let wire = serde_json::to_string(&seen.map(maestro_protocol::PullRequestCi::from))
                .expect("serialize");
            let stored: Option<maestro_protocol::PullRequestCi> =
                serde_json::from_str(&wire).expect("deserialize");
            let stored = stored.map(PullRequestCi::from);
            assert!(!ci_is_news(stored, seen), "for {state:?}");
        }
        assert!(ci_is_news(
            Some(PullRequestCi::Pending),
            Some(PullRequestCi::Failing)
        ));
        assert!(ci_is_news(Some(PullRequestCi::Passing), None));
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("git should be installed for merge tests");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[tokio::test]
    async fn squash_merge_conflict_restores_clean_target_branch() {
        let temp = tempfile::tempdir().expect("create temporary repository");
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "Maestro Test"]);
        git(repo, &["config", "user.email", "maestro@example.test"]);
        // Pin the settings the assertions below depend on, because the code under test runs git
        // itself and would otherwise pick these up from the developer's global config. With
        // core.autocrlf=true — the Git for Windows installer default — `reset --hard` restores
        // the file with CRLF endings; gpgsign or a global hooksPath fail the commits outright.
        git(repo, &["config", "core.autocrlf", "false"]);
        git(repo, &["config", "commit.gpgsign", "false"]);
        git(repo, &["config", "core.hooksPath", ""]);

        std::fs::write(repo.join("shared.txt"), "base\n").expect("write base file");
        git(repo, &["add", "shared.txt"]);
        git(repo, &["commit", "-m", "base"]);

        git(repo, &["checkout", "-b", "task-1"]);
        std::fs::write(repo.join("shared.txt"), "task change\n").expect("write task file");
        git(repo, &["commit", "-am", "task change"]);

        git(repo, &["checkout", "main"]);
        std::fs::write(repo.join("shared.txt"), "main change\n").expect("write main file");
        git(repo, &["commit", "-am", "main change"]);

        let connection = GitConnection::Local {
            path: repo.to_string_lossy().into_owned(),
        };
        let result = squash_merge_to_base(&connection, "task-1", "main", "merge task")
            .await
            .expect("conflicts should be returned as a merge result");

        assert!(!result.success);
        assert_eq!(result.task_status, "InProgress");
        assert_eq!(result.conflicts, vec!["shared.txt"]);
        assert_eq!(git(repo, &["status", "--porcelain"]), "");
        assert_eq!(
            std::fs::read_to_string(repo.join("shared.txt")).expect("read restored file"),
            "main change\n"
        );
    }
}
