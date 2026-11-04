use super::exec::{run_git_in_dir, run_git_in_dir_lossy};
use crate::acp::connection_server::{query_project_store, reply};
use crate::connectivity::GitConnection;
use crate::core::{get_project_with_git_conn, AppState};
use crate::git::worktree_lifecycle::{delete_worktree_rows, task_worktree};
use crate::git::MergeResult;
use crate::task::crud::get_task_on_server;
use crate::task::models::RunMode;
use crate::task::ops::{apply_transition_on_server, apply_transition_writing};
use crate::task::Task;
use maestro_protocol::{
    LoopCheck, LoopCheckKind, LoopCheckState, LoopIteration, SaveTaskReviewRequest, TaskRef,
    TaskTransition, TaskUpdate, TransitionGuard,
};
use maestro_protocol::{ServerRequest, ServerResponse};
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

async fn loop_checks(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<LoopCheck>, String> {
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ListLoopChecks(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListLoopChecksOk(list) => list.checks),
    )
    .await
}

async fn loop_iterations(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<LoopIteration>, String> {
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ListLoopIterations(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListLoopIterationsOk(list) => list.iterations),
    )
    .await
}

/// A loop is signed off only once every check on its list passes and no proposal waits for an
/// answer. Read here, at the approval, because any commit after a manual tick clears it.
async fn require_signed_off(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    let open = unsigned(&loop_checks(app_state, project_id, task_id).await?);
    match open.is_empty() {
        true => Ok(()),
        false => Err(format!(
            "This loop cannot be signed off yet: {}.",
            open.join("; ")
        )),
    }
}

/// What still stands between a loop and its sign-off, one phrase per check.
fn unsigned(checks: &[LoopCheck]) -> Vec<String> {
    // The steps only prepare the checks.
    let checks: Vec<&LoopCheck> = checks
        .iter()
        .filter(|check| check.kind != LoopCheckKind::Setup)
        .collect();
    if !checks.iter().any(|check| !check.proposed || check.accepted) {
        return vec!["it has no checks to say it is done".to_string()];
    }
    checks
        .into_iter()
        .filter_map(|check| {
            let why = if check.proposed && !check.accepted {
                "is a proposal waiting for your answer"
            } else if check.state == LoopCheckState::Pass {
                return None;
            } else if check.kind == LoopCheckKind::Manual {
                "is not ticked"
            } else {
                "does not pass"
            };
            Some(format!("\"{}\" {why}", check.label))
        })
        .collect()
}

/// A loop's pull request body: the judge's digest, or with none the description and what the
/// loop's record flags, then the checklist and how many iterations it took.
async fn loop_pull_request_body(app_state: &Arc<AppState>, task: &Task) -> Result<String, String> {
    let (project_id, task_id) = (task.project_id, task.id);
    let comments = query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskComments(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskCommentsOk(list) => list.comments),
    )
    .await?;
    let checks = loop_checks(app_state, project_id, task_id).await?;
    let iterations = loop_iterations(app_state, project_id, task_id).await?;
    let digest = comments
        .into_iter()
        .rev()
        .find(|c| c.kind == "digest")
        .and_then(|c| c.body);
    Ok(loop_body(
        task.description.as_deref(),
        digest.as_deref(),
        &checks,
        &iterations,
    ))
}

fn loop_body(
    description: Option<&str>,
    digest: Option<&str>,
    checks: &[LoopCheck],
    iterations: &[LoopIteration],
) -> String {
    let mut body = match digest.map(str::trim).filter(|d| !d.is_empty()) {
        Some(digest) => digest.to_string(),
        None => description.unwrap_or_default().trim().to_string(),
    };
    if !checks.is_empty() {
        body.push_str("\n\n### Checks\n");
        for check in checks {
            let ticked = if check.state == LoopCheckState::Pass {
                "x"
            } else {
                " "
            };
            body.push_str(&format!("\n- [{ticked}] {}", check.label));
        }
    }
    let count = iterations.iter().filter(|i| i.counted).count();
    body.push_str(&format!(
        "\n\nWritten by a Maestro loop in {count} iteration{}.",
        if count == 1 { "" } else { "s" }
    ));
    body.trim_start().to_string()
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
    let project = crate::project::crud::load_project(&app_state, project_id)?;
    let connection_key = project.connection_key();
    let (task_name, base_branch, external_id, description, project_path) = (
        task.title,
        task.base_branch,
        task.external_id,
        task.description,
        project.path,
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
    // Before anything is committed: an approval refused here leaves the worktree as it was.
    if task.run_mode == RunMode::Loop {
        require_signed_off(app_state.inner(), project_id, task_id).await?;
    }
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

    // A loop sent back by its pull request's CI is signed off onto that pull request, whatever
    // strategy was picked: the fix is pushed and the forge is waited on again, as a coder's is.
    if task.run_mode == RunMode::Loop && task.pull_request_number.is_some() {
        let status = crate::integration::code_hosting_handlers::code_hosting_status(
            app_state.inner(),
            project_id,
        )
        .await?;
        let Some(remote) = status.remote else {
            return Err(
                "This project has no git remote, so the fix cannot reach its pull request."
                    .to_string(),
            );
        };
        crate::git::push_branch(&git_conn, &full_worktree_path, &remote, &branch_name).await?;
        // The verdict that asked for the fix must not outlive it.
        apply_transition_writing(
            app_state.inner(),
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
        .await?;
        return Ok(MergeResult {
            success: true,
            task_status: "Review".to_string(),
            conflicts: vec![],
            pull_request_url: task.pull_request_url.clone(),
        });
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

    let body = match task.run_mode {
        RunMode::Loop => loop_pull_request_body(app_state, task).await?,
        RunMode::Pipeline => task.description.clone().unwrap_or_default(),
    };

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
        &body,
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

#[cfg(test)]
mod loop_tests {
    use super::*;

    fn check(label: &str, kind: LoopCheckKind, state: LoopCheckState) -> LoopCheck {
        LoopCheck {
            id: 1,
            position: 0,
            kind,
            label: label.to_string(),
            command: None,
            timeout_secs: None,
            state,
            detail: None,
            proposed: false,
            accepted: false,
            passed_at_sha: None,
            updated_at: String::new(),
        }
    }

    fn iteration(n: i32) -> LoopIteration {
        LoopIteration {
            n,
            attempt: 1,
            acp_session_id: None,
            agent_id: None,
            started_at: String::new(),
            ended_at: None,
            outcome: maestro_protocol::LoopIterationOutcome::Checked,
            counted: true,
            commit_sha: None,
            files: 0,
            added: 0,
            removed: 0,
            summary: None,
            check_output: None,
            tokens: None,
            blocked: None,
            results: vec![],
        }
    }

    #[test]
    fn a_loop_signs_off_only_with_every_check_passing_and_every_proposal_answered() {
        let mut proposal = check(
            "Empty lists",
            LoopCheckKind::Command,
            LoopCheckState::Pending,
        );
        proposal.proposed = true;
        let checks = [
            check("Tests pass", LoopCheckKind::Command, LoopCheckState::Pass),
            check(
                "Scrolls smoothly",
                LoopCheckKind::Manual,
                LoopCheckState::Pending,
            ),
            proposal,
        ];
        assert_eq!(
            unsigned(&checks),
            [
                "\"Scrolls smoothly\" is not ticked",
                "\"Empty lists\" is a proposal waiting for your answer"
            ]
        );
        assert!(unsigned(&checks[..1]).is_empty());
        assert_eq!(
            unsigned(&checks[2..]),
            ["it has no checks to say it is done"],
            "nothing but a proposal"
        );
        assert_eq!(unsigned(&[]), ["it has no checks to say it is done"]);
        let failed_step = check("Install", LoopCheckKind::Setup, LoopCheckState::Fail);
        assert!(unsigned(&[checks[0].clone(), failed_step.clone()]).is_empty());
        assert_eq!(
            unsigned(&[failed_step]),
            ["it has no checks to say it is done"],
            "a step is not a check"
        );
    }

    #[test]
    fn a_loop_pull_request_leads_with_the_digest_or_else_the_description() {
        let checks = [
            check("Tests pass", LoopCheckKind::Command, LoopCheckState::Pass),
            check("Reads well", LoopCheckKind::Judge, LoopCheckState::Pass),
        ];
        let iterations = [iteration(1), iteration(2)];
        let with = loop_body(
            Some("Make it fast"),
            Some("### What changed\nThe cache."),
            &checks,
            &iterations,
        );
        assert_eq!(
            with,
            "### What changed\nThe cache.\n\n### Checks\n\n- [x] Tests pass\n- [x] Reads well\n\n\
             Written by a Maestro loop in 2 iterations."
        );
        let without = loop_body(Some("Make it fast"), None, &checks, &iterations);
        assert!(
            without.starts_with("Make it fast\n\n### Checks"),
            "{without}"
        );
    }
}
