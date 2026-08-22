use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::Utc;
use rusqlite::Connection;
use crate::models::{GitConnection, MergeResult, PullRequestCi};
use crate::core::{AppState, get_project_with_git_conn};
use crate::acp::ConnectionKey;
use crate::task::transition::{self, TaskTransition};
use super::exec::{run_git_in_dir, run_git_in_dir_lossy};

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

    // Step 1: checkout target branch
    run_git_in_dir(conn, repo_path, &["checkout", target_branch])
        .await
        .map_err(|e| format!("git checkout {} failed: {}", target_branch, e))?;

    // Step 2: squash merge (non-zero exit expected on conflicts)
    let _ = run_git_in_dir_lossy(conn, repo_path, &["merge", branch_name, "--squash", "--no-commit"]).await;

    // Step 3: check for conflicts via git status --porcelain
    let status_stdout = run_git_in_dir(conn, repo_path, &["status", "--porcelain"])
        .await
        .map_err(|e| format!("git status failed: {}", e))?;
    let conflicts = parse_conflict_files(&status_stdout);

    // Step 4a: conflicts detected — clean up staged conflict markers and return.
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

    // Step 4b: nothing staged — branches may already be identical.
    // Use diff --cached to check staged content specifically (git status --porcelain
    // includes pre-existing unstaged modifications which would give a false positive).
    let staged_output = run_git_in_dir(conn, repo_path, &["diff", "--cached", "--name-only"])
        .await
        .map_err(|e| format!("git diff --cached failed: {}", e))?;

    if staged_output.trim().is_empty() {
        return Err(format!(
            "Nothing to merge: no changes between {} and {}",
            branch_name, target_branch
        ));
    }

    // Step 5: commit with caller-provided message
    run_git_in_dir(conn, repo_path, &["commit", "--no-verify", "-m", commit_message])
        .await
        .map_err(|e| format!("git commit failed: {}", e))?;

    // Step 6: return success
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
    task_id: i32,
) -> Result<String, String> {
    // LEFT JOIN, not JOIN: a task with `isolated_worktree` off has no worktree row, and this used
    // to fail outright — which left the approve dialog with an empty commit message and its
    // confirm button permanently disabled.
    let (task_name, branch_name, base_branch, external_id, description, project_path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.title, w.branch_name, t.base_branch, t.external_id, t.description, p.path, p.connection_id, p.wsl_connection_id, p.docker_connection_id
             FROM tasks t
             LEFT JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                ConnectionKey::from_all_ids(row.get(6)?, row.get(7)?, row.get(8)?),
            )),
        )
        .map_err(|e| format!("Task/project not found: {}", e))?
    };

    let default_template = match branch_name {
        Some(_) => DEFAULT_COMMIT_TEMPLATE,
        None => DEFAULT_COMMIT_TEMPLATE_IN_PLACE,
    };
    // With no worktree there is no branch of the task's own, so `{branch}` names the branch the
    // work actually landed on.
    let branch_name = branch_name.unwrap_or_else(|| base_branch.clone());

    // A project that never customised its template has no file, which is not an error.
    let template_path = format!("{}/.maestro/commit-template.txt", project_path);
    let template = match crate::core::git_connection_for(&app_state, project_path.clone(), connection_key).await {
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
    task_id: i32,
    merge_strategy: String,
    include_untracked: bool,
    commit_message: String,
) -> Result<MergeResult, String> {

    // 1. Single query for task, worktree and project data. The worktree side is a LEFT JOIN: a
    // task with `isolated_worktree` off has no row there, and an inner join made approving one
    // fail with "Task, worktree, or project not found" — a dead end, since Review is where the
    // pipeline puts it.
    let (worktree, project_id, repo_path, base_branch) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT w.branch_name, w.path, w.id, t.project_id, p.path, t.base_branch
             FROM tasks t
             LEFT JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| {
                let worktree = match (
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i32>>(2)?,
                ) {
                    (Some(branch_name), Some(path), Some(id)) => Some((branch_name, path, id)),
                    _ => None,
                };
                Ok((worktree, row.get::<_, i32>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
            },
        )
        .map_err(|e| format!("Task or project not found: {}", e))?
    };

    // 2. Resolve git connection for this project
    let (_project, git_conn) = get_project_with_git_conn(app_state.inner(), project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

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
    run_git_in_dir(&git_conn, &full_worktree_path, &["add", "-u"]).await
        .map_err(|e| format!("Failed to stage modified files: {}", e))?;

    // 3b. Also stage untracked files if user opted in
    if include_untracked {
        let untracked_output = run_git_in_dir(
            &git_conn, &full_worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        ).await.unwrap_or_default();

        let untracked_files: Vec<&str> = untracked_output
            .lines()
            .filter(|line| !line.is_empty())
            .collect();

        if !untracked_files.is_empty() {
            let mut add_args = vec!["add", "--"];
            add_args.extend(untracked_files.iter().copied());
            run_git_in_dir(&git_conn, &full_worktree_path, &add_args).await
                .map_err(|e| format!("Failed to stage untracked files: {}", e))?;
        }
    }

    // 3c. Commit everything staged (modified + untracked if included)
    let staged_output = run_git_in_dir(
        &git_conn, &full_worktree_path,
        &["diff", "--cached", "--name-only"],
    ).await.unwrap_or_default();

    if !staged_output.trim().is_empty() {
        run_git_in_dir(
            &git_conn, &full_worktree_path,
            &["commit", "--no-verify", "-m", &commit_message],
        ).await.map_err(|e| format!("Failed to commit changes: {}", e))?;
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
                "This project has no git remote, so there is nothing to push to.".to_string()
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
            task_id,
            project_id,
            &git_conn,
            &full_worktree_path,
            &branch_name,
            &base_branch,
        )
        .await?;
        app_state.app_handle.emit("tasks-changed", ()).ok();
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
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            transition::apply(&conn, task_id, TaskTransition::ApprovedWithoutMerge)?;
        }
        app_state.app_handle.emit("tasks-changed", ()).ok();
        return Ok(MergeResult {
            success: true,
            task_status: "Done".to_string(),
            conflicts: vec![],
            pull_request_url: None,
        });
    }

    // 4. Perform squash merge via git dispatcher (local, SSH, or WSL)
    let merge_result = squash_merge_to_base(
        &git_conn,
        &branch_name,
        &base_branch,
        &commit_message,
    ).await?;

    if merge_result.success {
        // 4a. Merge succeeded - finalize (mark Done, cleanup worktree)
        finalize_successful_merge(
            app_state.inner(),
            task_id,
            worktree_id,
            &full_worktree_path,
            &branch_name,
            TaskTransition::Merged,
        )
        .await?;
        app_state.app_handle.emit("tasks-changed", ()).ok();
        app_state.app_handle.emit("worktrees-changed", ()).ok();
        Ok(MergeResult {
            success: true,
            task_status: "Done".to_string(),
            conflicts: vec![],
            pull_request_url: None,
        })
    } else if !merge_result.conflicts.is_empty() {
        // 4b. Merge had conflicts - reject back to InProgress
        reject_merge_on_conflict(app_state.inner(), task_id, &merge_result.conflicts).await?;
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
    task_id: i32,
    project_id: i32,
    git_conn: &GitConnection,
    worktree_path: &str,
    branch_name: &str,
    base_branch: &str,
) -> Result<String, String> {
    use crate::integration::code_hosting_handlers::{code_hosting_status, CodeHostingRung};
    use crate::integration::issue_tracking_handlers::find_integration;
    use crate::integration::pull_request::{create_pull_request, PullRequestTarget};

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
    let integration = find_integration(&config.provider, &config.host, app_state)
        .await
        .ok_or_else(|| {
            format!(
                "No {} credentials are available, so the pull request cannot be opened. Connect \
                 {} in Settings, or push the branch and open it yourself.",
                config.provider, config.provider
            )
        })?;

    // The branch has to exist on the remote before the forge will accept a PR for it.
    crate::git::push_branch(git_conn, worktree_path, &remote, branch_name).await?;

    let (title, description) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT title, description FROM tasks WHERE id = ?",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(|e| format!("Task {} not found: {}", task_id, e))?
    };

    let created = create_pull_request(
        &PullRequestTarget {
            config: &config,
            instance_url: integration.instance_url.as_deref(),
            token: &integration.token,
        },
        branch_name,
        base_branch,
        &title,
        description.as_deref().unwrap_or(""),
    )
    .await?;

    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            // `pull_request_ci` is cleared alongside, or a second pull request on the same task
            // would inherit the first one's verdict until the next sweep overwrote it.
            "UPDATE tasks SET pull_request_url = ?, pull_request_number = ?, \
             pull_request_ci = NULL WHERE id = ?",
            rusqlite::params![&created.url, created.number, task_id],
        )
        .map_err(|e| format!("Failed to record the pull request: {}", e))?;
        transition::apply(&conn, task_id, TaskTransition::PullRequestOpened)?;
    }

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
        fetch_ci_state, fetch_pull_request, CiState, PullRequestState, PullRequestTarget,
    };

    let waiting: Vec<(i32, i64)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, pull_request_number FROM tasks \
                 WHERE project_id = ? AND phase = 'AwaitingMerge' AND pull_request_number IS NOT NULL \
                   AND archived_at IS NULL",
            )
            .map_err(|e| format!("Failed to query tasks awaiting merge: {}", e))?;
        let rows = stmt
            .query_map([project_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("Failed to read tasks awaiting merge: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read tasks awaiting merge: {}", e))?;
        rows
    };

    if waiting.is_empty() {
        return Ok(vec![]);
    }

    // Resolved once for the whole sweep rather than per task: every one of these pull requests is
    // on the same project's remote, and a token probe can spawn the `gh` CLI.
    let status = code_hosting_status(app_state.inner(), project_id).await?;
    let Some(config) = status.config else {
        return Ok(vec![]);
    };
    let Some(integration) = find_integration(&config.provider, &config.host, app_state.inner()).await
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

    let mut changed = Vec::new();
    let mut landed = false;
    for (task_id, number) in waiting {
        let details = match fetch_pull_request(&target, number).await {
            Ok(details) => details,
            Err(e) => {
                log::warn!("Could not read pull request #{} for task {}: {}", number, task_id, e);
                continue;
            }
        };

        match details.state {
            PullRequestState::Open => {
                let (ball, fix_rounds): (String, i32) = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT ball, fix_rounds FROM tasks WHERE id = ?",
                        [task_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|e| format!("Task {} not found: {}", task_id, e))?
                };

                // The forge only moves a task nobody is holding. A conflict surfacing while a
                // CI-fix coder is mid-turn would take the session's task out from under it, and
                // that turn ends in a push the next sweep should be reading anyway.
                if ball == "External" && details.mergeable == Some(false) {
                    {
                        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                        transition::apply(&conn, task_id, TaskTransition::PullRequestConflicted)?;
                    }
                    log::info!("Pull request #{} conflicts; task {} needs a rebase", number, task_id);
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
                if ball == "User" {
                    if details.mergeable != Some(true) {
                        continue;
                    }
                    {
                        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                        transition::apply(&conn, task_id, TaskTransition::PullRequestMergeable)?;
                    }
                    log::info!("Pull request #{} merges again; task {} is back with the forge", number, task_id);
                    changed.push(task_id);
                }

                let ci = match fetch_ci_state(&target, number, details.head_sha.as_deref()).await {
                    Ok(ci) => ci,
                    Err(e) => {
                        log::warn!("Could not read CI for pull request #{}: {}", number, e);
                        continue;
                    }
                };

                let touched = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    let fixing = match &ci {
                        CiState::Failing(checks) => {
                            request_ci_fix(&conn, task_id, number, checks, &ball, fix_rounds)?
                        }
                        _ => false,
                    };
                    let recorded = record_pull_request_ci(&conn, task_id, cached_ci(&ci))?;
                    fixing || recorded
                };
                if touched && changed.last() != Some(&task_id) {
                    changed.push(task_id);
                }
            }
            PullRequestState::Merged => {
                if let Err(e) = land_merged_pull_request(app_state.inner(), task_id).await {
                    log::warn!("Pull request #{} merged but task {} could not land: {}", number, task_id, e);
                    continue;
                }
                changed.push(task_id);
                landed = true;
            }
            PullRequestState::Closed => {
                {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    transition::apply(&conn, task_id, TaskTransition::PullRequestClosed)?;
                }
                log::info!("Pull request #{} was closed without merging; task {} needs a decision", number, task_id);
                changed.push(task_id);
            }
        }
    }

    if !changed.is_empty() {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
    // Only a merge touches a worktree. Emitting this for every CI verdict would refetch the
    // worktree list every three minutes for every open pull request.
    if landed {
        app_state.app_handle.emit("worktrees-changed", ()).ok();
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
fn record_pull_request_ci(
    conn: &Connection,
    task_id: i32,
    ci: Option<PullRequestCi>,
) -> Result<bool, String> {
    let stored: Option<String> = conn
        .query_row("SELECT pull_request_ci FROM tasks WHERE id = ?", [task_id], |row| row.get(0))
        .map_err(|e| format!("Task {} not found: {}", task_id, e))?;

    let next = ci.map(PullRequestCi::as_str);
    if stored.as_deref() == next {
        return Ok(false);
    }

    conn.execute(
        "UPDATE tasks SET pull_request_ci = ? WHERE id = ?",
        rusqlite::params![next, task_id],
    )
    .map_err(|e| format!("Could not record CI for task {}: {}", task_id, e))?;
    Ok(true)
}

/// Send an agent to fix a red build, if the loop has rounds left, and report whether one was sent.
///
/// The caller has already established that CI finished and failed. Pending, passing, absent and
/// unreadable never reach here, because the only thing this does is start an agent that pushes
/// commits to an open pull request, and every unclear case resolves itself on the next sweep.
fn request_ci_fix(
    conn: &Connection,
    task_id: i32,
    number: i64,
    checks: &[String],
    ball: &str,
    fix_rounds: i32,
) -> Result<bool, String> {
    // Already being fixed, or already back with the user. Either way not ours.
    if ball != "External" || fix_rounds >= FIX_ROUND_CAP {
        return Ok(false);
    }

    // The failing checks go in the outcome thread rather than into a prompt from here, because the
    // agent is started by the frontend and this is the same route the reviewer's findings take.
    let report = format!(
        "CI failed on pull request #{}. Failing checks:\n\n{}",
        number,
        checks.iter().map(|check| format!("- {}", check)).collect::<Vec<_>>().join("\n")
    );

    crate::task::comments::append(
        conn,
        task_id,
        "ci",
        "maestro",
        Some(&report),
        None,
        Some("AwaitingMerge"),
    )?;
    conn.execute("UPDATE tasks SET fix_rounds = fix_rounds + 1 WHERE id = ?", [task_id])
        .map_err(|e| format!("Could not count a fix round for task {}: {}", task_id, e))?;
    transition::apply(conn, task_id, TaskTransition::CiFixRequested)?;

    log::info!(
        "CI failed on pull request #{} for task {} ({}); sending an agent (round {} of {})",
        number,
        task_id,
        checks.join(", "),
        fix_rounds + 1,
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
pub(crate) async fn push_ci_fix(app_state: &AppState, task_id: i32) -> Result<(), String> {
    let row = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.project_id, w.path, w.branch_name, p.path FROM tasks t \
             JOIN worktrees w ON w.task_id = t.id JOIN projects p ON p.id = t.project_id \
             WHERE t.id = ? LIMIT 1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, i32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| format!("No worktree for task {}: {}", task_id, e))?
    };
    let (project_id, worktree_rel_path, branch_name, repo_path) = row;

    let (_project, git_conn) = get_project_with_git_conn(app_state, project_id).await?;
    let status =
        crate::integration::code_hosting_handlers::code_hosting_status(app_state, project_id)
            .await?;
    let remote = status.remote.ok_or_else(|| "The project has no remote to push to".to_string())?;

    crate::git::push_branch(
        &git_conn,
        &format!("{}/{}", repo_path, worktree_rel_path),
        &remote,
        &branch_name,
    )
    .await?;

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    transition::apply(&conn, task_id, TaskTransition::CiFixPushed).map(|_| ())
}

/// Land a task whose pull request merged: Done with the `MergedViaPR` qualifier, worktree and
/// branch cleaned up.
///
/// The branch is deleted locally only. Whether the *remote* branch goes is the forge's setting,
/// not ours — deleting it here would override a repository that keeps merged branches.
async fn land_merged_pull_request(app_state: &Arc<AppState>, task_id: i32) -> Result<(), String> {
    let worktree = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT w.id, w.path, w.branch_name, p.path FROM worktrees w \
             JOIN projects p ON p.id = w.project_id WHERE w.task_id = ? LIMIT 1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, i32>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .ok()
    };

    // A task can reach here with no worktree row — the user may have removed it while the PR was
    // open. The merge still happened, so the task still lands; there is simply nothing to clean up.
    let Some((worktree_id, worktree_rel_path, branch_name, repo_path)) = worktree else {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        return transition::apply(&conn, task_id, TaskTransition::PullRequestMerged).map(|_| ());
    };

    finalize_successful_merge(
        app_state,
        task_id,
        worktree_id,
        &format!("{}/{}", repo_path, worktree_rel_path),
        &branch_name,
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
    task_id: i32,
    worktree_id: i32,
    worktree_path: &str,
    branch_name: &str,
    landed: TaskTransition,
) -> Result<(), String> {
    // Note: DB writes are intentionally split across lock acquisitions because async
    // git cleanup happens between task update and worktree deletion. If the process
    // crashes between these steps, cleanup_zombie_worktrees handles recovery.

    // 1. Update task status to Done
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        transition::apply(&conn, task_id, landed)?;
    }

    // 2. Delete worktree from disk via git dispatcher (and DB on success)
    // Resolve git connection for this project
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT project_id FROM worktrees WHERE id = ?",
            rusqlite::params![worktree_id],
            |row| row.get::<_, i32>(0),
        ).map_err(|e| format!("Worktree {} not found: {}", worktree_id, e))?
    };
    let (_project, git_conn) = get_project_with_git_conn(app_state, project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    match crate::git::delete_worktree(&git_conn, worktree_path).await {
        Ok(()) => {
            // Delete branch — non-fatal, best effort
            let _ = run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-D", branch_name]).await;
            // Delete from database on successful cleanup
            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "DELETE FROM worktrees WHERE id = ?",
                    rusqlite::params![worktree_id],
                )
                .map_err(|e| format!("Failed to delete worktree from DB: {}", e))?;
            }
        }
        Err(_e) => {
            // Cleanup failed — zombie cleanup will retry
        }
    }

    Ok(())
}

/// Reject a merge and move task back to InProgress with conflict feedback
///
/// Helper function (private crate-level) called when merge conflicts are detected:
/// 1. Updates task status back to InProgress for the agent to rework
/// 2. Creates a RequestChanges review with formatted conflict feedback
///
/// Provides visibility to reviewers about which files had conflicts.
/// Record a review decision for a task that may already have one.
///
/// `task_reviews.task_id` is UNIQUE, and by the time a merge conflict is reported the approve
/// flow has already written an `Approve` row for that task. A plain INSERT therefore collided
/// every single time: the transition had run, so the task really did move to Rework, but the
/// conflict feedback was lost and the caller saw a generic failure instead of the conflict.
///
/// `ON CONFLICT DO UPDATE` rather than `INSERT OR REPLACE`, because REPLACE deletes the existing
/// row and `review_comments.review_id` cascades off it — it would take the user's per-file
/// comments with it. Updating in place keeps the row id, and the comments hanging off it.
fn upsert_review_feedback(
    conn: &rusqlite::Connection,
    task_id: i32,
    decision: &str,
    general_feedback: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(task_id) DO UPDATE SET
             decision = excluded.decision,
             general_feedback = excluded.general_feedback,
             reviewed_at = excluded.reviewed_at",
        rusqlite::params![task_id, decision, general_feedback, now],
    )
    .map_err(|e| format!("Save feedback failed: {}", e))?;
    Ok(())
}

pub(crate) async fn reject_merge_on_conflict(
    app_state: &Arc<AppState>,
    task_id: i32,
    conflicts: &[String],
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let conflict_feedback = format!("Merge conflict detected:\n{}", conflicts.join("\n"));

    // Auto-reject to InProgress per CONTEXT.md decision
    transition::apply(&conn, task_id, TaskTransition::MergeConflict)?;

    upsert_review_feedback(&conn, task_id, "RequestChanges", &conflict_feedback, &now)?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    /// A merge conflict arrives after the approve flow has already written an `Approve` row, so
    /// this path has to survive a task that already has a review. It used to fail on the UNIQUE
    /// constraint every time, losing the conflict feedback and reporting a generic error.
    #[test]
    fn conflict_feedback_replaces_an_existing_review_without_dropping_comments() {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        crate::core::schema::initialize_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'demo task', 'Review', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert task");

        conn.execute(
            "INSERT INTO task_reviews (task_id, decision, general_feedback, created_at) \
             VALUES (1, 'Approve', 'looks good', '2026-01-01')",
            [],
        )
        .expect("insert approve row");
        let review_id: i32 = conn
            .query_row("SELECT id FROM task_reviews WHERE task_id = 1", [], |r| r.get(0))
            .expect("read review id");
        conn.execute(
            "INSERT INTO review_comments (review_id, file_path, comment, created_at) \
             VALUES (?, 'src/main.rs', 'rename this', '2026-01-01')",
            [review_id],
        )
        .expect("insert comment");

        upsert_review_feedback(&conn, 1, "RequestChanges", "Merge conflict detected:\nsrc/main.rs", "2026-02-02")
            .expect("upsert must not collide with the existing review");

        let (id, decision, feedback): (i32, String, String) = conn
            .query_row(
                "SELECT id, decision, general_feedback FROM task_reviews WHERE task_id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("review still present");

        assert_eq!(id, review_id, "the row must be updated in place, not replaced");
        assert_eq!(decision, "RequestChanges");
        assert!(feedback.contains("Merge conflict"));

        let comments: i32 = conn
            .query_row("SELECT COUNT(*) FROM review_comments WHERE review_id = ?", [review_id], |r| {
                r.get(0)
            })
            .expect("count comments");
        assert_eq!(comments, 1, "per-file comments must survive — REPLACE would cascade them away");

        let rows: i32 = conn
            .query_row("SELECT COUNT(*) FROM task_reviews WHERE task_id = 1", [], |r| r.get(0))
            .expect("count reviews");
        assert_eq!(rows, 1);
    }

    /// A task parked at `AwaitingMerge` with an open pull request, in the state the sweep finds it.
    fn awaiting_merge() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        crate::core::schema::initialize_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, phase, phase_status, \
             ball, pull_request_number, created_at, updated_at) \
             VALUES (1, 1, 'demo task', 'Review', 'main', 'AwaitingMerge', 'Waiting', 'External', \
             7, '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert task");
        conn
    }

    /// The sweep runs every three minutes against every open pull request, and its caller turns a
    /// non-empty changed list into a board-wide refetch. A blind write would therefore refetch the
    /// whole board for every open pull request for ever, whether or not CI had moved.
    #[test]
    fn a_settled_pull_request_is_not_news() {
        let conn = awaiting_merge();

        assert!(
            record_pull_request_ci(&conn, 1, Some(PullRequestCi::Passing)).expect("record"),
            "the first verdict is always news"
        );
        assert!(
            !record_pull_request_ci(&conn, 1, Some(PullRequestCi::Passing)).expect("record"),
            "the same verdict again is not"
        );
        assert!(
            record_pull_request_ci(&conn, 1, Some(PullRequestCi::Failing)).expect("record"),
            "a build going red is"
        );

        // Losing CI entirely — a rerun that clears the checks, or a repository that drops them —
        // has to clear the cache too, or the card would keep claiming a verdict nobody holds.
        assert!(record_pull_request_ci(&conn, 1, None).expect("record"));
        assert!(!record_pull_request_ci(&conn, 1, None).expect("record"));

        let stored: Option<String> = conn
            .query_row("SELECT pull_request_ci FROM tasks WHERE id = 1", [], |row| row.get(0))
            .expect("read back");
        assert_eq!(stored, None);
    }

    /// The fix loop only acts on a pull request the forge still holds, and only while rounds
    /// remain. Both guards matter for spend: each round pushes commits to a pull request other
    /// people can see.
    #[test]
    fn a_red_build_is_only_fixed_for_a_task_the_forge_still_holds() {
        let checks = vec!["test".to_string()];

        let conn = awaiting_merge();
        assert!(
            !request_ci_fix(&conn, 1, 7, &checks, "Agent", 0).expect("fix"),
            "a coder is already on it"
        );
        assert!(
            !request_ci_fix(&conn, 1, 7, &checks, "External", FIX_ROUND_CAP).expect("fix"),
            "the rounds are spent and the user has to look"
        );

        let rounds: i32 = conn
            .query_row("SELECT fix_rounds FROM tasks WHERE id = 1", [], |row| row.get(0))
            .expect("read rounds");
        assert_eq!(rounds, 0, "a refusal must not count as a round");

        assert!(request_ci_fix(&conn, 1, 7, &checks, "External", 0).expect("fix"));

        let (rounds, ball): (i32, String) = conn
            .query_row("SELECT fix_rounds, ball FROM tasks WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("read task");
        assert_eq!(rounds, 1);
        assert_eq!(ball, "Agent", "the board starts the coder off the ball");

        // The findings reach the coder through the thread, the same route the reviewer's take.
        let report: String = conn
            .query_row(
                "SELECT body FROM task_comments WHERE task_id = 1 AND kind = 'ci'",
                [],
                |row| row.get(0),
            )
            .expect("ci entry");
        assert!(report.contains("test"), "the failing check has to be named: {report}");
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
