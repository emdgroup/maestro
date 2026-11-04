//! The pull request sweep: what became of every pull request a project's tasks wait on.
//!
//! Task-oriented, unlike the branch-oriented commands in `pull_request_handlers`: it moves tasks
//! through the pipeline according to what the forge reports.

use std::sync::Arc;

use maestro_protocol::{
    NewTaskComment, ProjectRef, ServerRequest, ServerResponse, TaskTransition, TaskUpdate,
    TransitionGuard,
};
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::core::AppState;
use crate::git::merge::finalize_successful_merge;
use crate::git::worktree_lifecycle::task_worktree;
use crate::task::crud::{get_task_on_server, update_task_on_server};
use crate::task::ops::{apply_transition_on_server, apply_transition_writing};
use crate::task::{PullRequestCi, Task, TaskBall};

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
            pull_request_ci: Some(ci),
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
    // The failing checks go in the outcome thread rather than into a prompt from here: the daemon
    // composes the coder's prompt from the thread, the same route the reviewer's findings take.
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
    let project = crate::project::crud::load_project(app_state, project_id)?;

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

#[cfg(test)]
mod tests {
    use super::*;

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
            let wire = serde_json::to_string(&seen).expect("serialize");
            let stored: Option<maestro_protocol::PullRequestCi> =
                serde_json::from_str(&wire).expect("deserialize");
            assert!(!ci_is_news(stored, seen), "for {state:?}");
        }
        assert!(ci_is_news(
            Some(PullRequestCi::Pending),
            Some(PullRequestCi::Failing)
        ));
        assert!(ci_is_news(Some(PullRequestCi::Passing), None));
    }
}
