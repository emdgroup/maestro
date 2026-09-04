//! Branch-oriented pull request commands, for the session side panel.
//!
//! Distinct from the task-oriented ones in `git::merge`, and deliberately so. Those are steps in
//! the pipeline: they move a task's phase, and `reconcile_pull_requests` sweeps what they wrote.
//! These two know nothing about tasks. They take a branch, ask the forge about it, and write
//! nothing — which is what lets the panel show a pull request opened outside Maestro, and what
//! keeps a session that has no task from needing a row to hang state on.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::core::AppState;
use crate::integration::code_hosting_handlers::{CodeHostingRung, code_hosting_status};
use crate::integration::issue_tracking_handlers::find_integration;
use crate::integration::pull_request::{
    CheckStatus, PullRequestCheck, PullRequestState, PullRequestTarget, create_pull_request,
    enumerates_checks, fetch_ci_checks, fetch_open_pull_request_checks, fetch_pull_request,
    list_open_pull_requests,
    preferred_credential_base, supports_pull_request_list, supports_pull_requests,
};

/// What became of a pull request, for the panel.
///
/// Mirrors [`PullRequestState`], which cannot be exported itself: it is `Copy` plumbing shared by
/// every provider and giving it a `specta` derive would put forge internals in the bindings.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum BranchPullRequestState {
    Open,
    Merged,
    Closed,
}

// What the Overview card renders is no longer any one command's answer, so it is no longer a type
// here. It is assembled in the panel from three: the project's open list, this module's facts, and
// the checks poll — see `SessionPullRequest` in `side-panel/useSessionShipState.ts`. Declaring it
// in Rust as well would be a second definition of a shape nothing on this side ever builds.

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PullRequestCheckInfo {
    pub name: String,
    pub status: PullRequestCheckStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum PullRequestCheckStatus {
    Passed,
    Failed,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct OpenedPullRequest {
    pub number: i64,
    pub url: String,
    /// Lets the caller put the new pull request straight into its cached open list instead of
    /// waiting out a poll: every other field it needs was in the request, and this is the one the
    /// checks query is keyed on. `None` on a forge whose create response omits it — see
    /// [`CreatedPullRequest::head_sha`].
    pub head_sha: Option<String>,
}

/// One open pull request, as the Worktrees view's panel and card chips read it.
///
/// Deliberately thin: no state, because every entry here is open by definition; no checks and no
/// line counts, because both cost a request each and are asked for separately by the one card the
/// user is actually looking at.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectPullRequest {
    pub number: i64,
    pub url: String,
    pub title: String,
    /// What the Worktrees view matches a worktree's `branch_name` against.
    pub head_branch: String,
    pub base_branch: Option<String>,
    pub created_at: Option<String>,
    pub head_sha: Option<String>,
}

/// Everything about one pull request that its *list* entry does not carry, plus what that entry
/// carries but cannot keep current.
///
/// One shape rather than the state/facts pair it replaces, because on every forge that answers both
/// they come out of the same request. Splitting them cost a request per poll and left `title` with
/// no owner at all — it came from the open list, so a rename waited a whole list cycle, and a
/// merged pull request has left that list for good and would have kept its old title forever.
///
/// Every field but `state` is optional: the forges disagree about which they answer, and an absent
/// one renders as a dropped line rather than a zero.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PullRequestDetailInfo {
    pub state: BranchPullRequestState,
    pub title: Option<String>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub head_sha: Option<String>,
    pub created_at: Option<String>,
    pub commits: Option<i64>,
    pub changed_files: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub mergeable: Option<bool>,
}

/// Resolve the forge and a credential for it, or say which of the two is missing.
///
/// Both commands below need exactly this and the messages are the user's only route out of the
/// failure, so they are written once here rather than drifting apart in two places.
async fn resolve_target(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<(crate::models::project::ProjectCodeHostingConfig, String, Option<String>), String> {
    let status = code_hosting_status(app_state, project_id).await?;
    let Some(config) = status.config else {
        return Err(match status.rung {
            CodeHostingRung::NoRemote => {
                "This project has no git remote, so there is no forge to ask.".to_string()
            }
            _ => "This project's remote is not on a forge Maestro recognises.".to_string(),
        });
    };

    let integration =
        find_integration(&config.provider, &config.host, preferred_credential_base(&config).as_deref(), app_state)
            .await
            .ok_or_else(|| {
                format!(
                    "No {} credentials are available. Connect {} in Settings.",
                    config.provider, config.provider
                )
            })?;

    Ok((config, integration.token, integration.instance_url))
}

fn to_check_info(check: PullRequestCheck) -> PullRequestCheckInfo {
    PullRequestCheckInfo {
        name: check.name,
        status: match check.status {
            CheckStatus::Passed => PullRequestCheckStatus::Passed,
            CheckStatus::Failed => PullRequestCheckStatus::Failed,
            CheckStatus::Running => PullRequestCheckStatus::Running,
        },
    }
}

/// Every pull request open on the project's forge.
///
/// One request answers the whole Worktrees view, and every open session's card besides. The
/// alternative — a branch search per card — gets slower as a project accumulates worktrees, which
/// is the wrong direction for a view whose whole purpose is having a lot of them.
///
/// Answers `Ok(vec![])` rather than an error when the project has no forge or no credential: a
/// project that never connected one should show no pull requests, not an error strip over a view
/// that works perfectly well without them.
#[tauri::command]
#[specta::specta]
pub async fn list_project_pull_requests(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ProjectPullRequest>, String> {
    let Ok((config, token, instance_url)) = resolve_target(app_state.inner(), project_id).await
    else {
        return Ok(Vec::new());
    };

    if !supports_pull_request_list(&config) {
        return Ok(Vec::new());
    }

    let target =
        PullRequestTarget { config: &config, instance_url: instance_url.as_deref(), token: &token };

    let listed = list_open_pull_requests(&target).await?;
    Ok(listed
        .into_iter()
        .map(|entry| ProjectPullRequest {
            number: entry.number,
            url: entry.url,
            title: entry.title,
            head_branch: entry.head_branch,
            base_branch: entry.base_branch,
            created_at: entry.created_at,
            head_sha: entry.head_sha,
        })
        .collect())
}

/// Everything the card shows about one pull request except its checks.
///
/// One request on every forge — the state half and the counts half come out of the same body, and
/// asking for them separately was two identical GETs per poll.
///
/// Split from the checks below because the two move at completely different speeds: this changes
/// when somebody pushes, renames or merges, and the checks change while you watch. Polling both at
/// the rate the checks need re-asks the forge for ten fields to learn one.
#[tauri::command]
#[specta::specta]
pub async fn fetch_pull_request_detail(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    number: i64,
) -> Result<PullRequestDetailInfo, String> {
    let (config, token, instance_url) = resolve_target(app_state.inner(), project_id).await?;
    let target =
        PullRequestTarget { config: &config, instance_url: instance_url.as_deref(), token: &token };

    let detail = fetch_pull_request(&target, number).await?;
    Ok(PullRequestDetailInfo {
        state: match detail.state {
            PullRequestState::Open => BranchPullRequestState::Open,
            PullRequestState::Merged => BranchPullRequestState::Merged,
            PullRequestState::Closed => BranchPullRequestState::Closed,
        },
        title: detail.title,
        base_branch: detail.base_ref,
        head_branch: detail.head_ref,
        head_sha: detail.head_sha,
        created_at: detail.created_at,
        commits: detail.commits,
        changed_files: detail.changed_files,
        additions: detail.additions,
        deletions: detail.deletions,
        mergeable: detail.mergeable,
    })
}

/// One open pull request's checks, as the Worktrees view reads them.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectPullRequestChecks {
    pub number: i64,
    /// The commit these describe, so the frontend can cache against it and skip a poll that
    /// changed nothing.
    pub head_sha: Option<String>,
    pub checks: Vec<PullRequestCheckInfo>,
}

/// Every open pull request's checks, for the Worktrees view's CI marks and its CI filter.
///
/// One command rather than one query per card. Asked per pull request this was two GitHub requests
/// each per poll, so a project with twenty open ones spent roughly an hourly token budget on a view
/// that was only showing coloured icons.
///
/// The open list is fetched here rather than taken as an argument: the fallback path needs each
/// pull request's head sha, and a list passed from a frontend poll would be a second copy of the
/// same answer that could disagree with this one.
#[tauri::command]
#[specta::specta]
pub async fn fetch_project_pull_request_checks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ProjectPullRequestChecks>, String> {
    let Ok((config, token, instance_url)) = resolve_target(app_state.inner(), project_id).await
    else {
        return Ok(Vec::new());
    };

    // Both capabilities, and `enumerates_checks` first — it is the one that makes the list below
    // worth fetching. A forge that lists pull requests but names no checks would otherwise pay a
    // full list request every cycle for a result this function then discards, which is exactly what
    // Bitbucket and Azure DevOps started doing the moment they gained a lister.
    if !enumerates_checks(&config) || !supports_pull_request_list(&config) {
        return Ok(Vec::new());
    }

    let target =
        PullRequestTarget { config: &config, instance_url: instance_url.as_deref(), token: &token };

    let open = list_open_pull_requests(&target).await?;
    let checks = fetch_open_pull_request_checks(&target, &open).await?;

    Ok(checks
        .into_iter()
        .map(|entry| ProjectPullRequestChecks {
            number: entry.number,
            head_sha: entry.head_sha,
            checks: entry.checks.into_iter().map(to_check_info).collect(),
        })
        .collect())
}

/// Just the checks for one pull request, for the panel's fast poll.
///
/// Takes the number detection already found rather than searching by branch — the whole point of
/// the project-wide open list is that nothing here has to ask "which pull request is this" again.
#[tauri::command]
#[specta::specta]
pub async fn fetch_branch_pull_request_checks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    number: i64,
    head_sha: Option<String>,
) -> Result<Vec<PullRequestCheckInfo>, String> {
    let (config, token, instance_url) = resolve_target(app_state.inner(), project_id).await?;
    let target =
        PullRequestTarget { config: &config, instance_url: instance_url.as_deref(), token: &token };

    let checks = fetch_ci_checks(&target, number, head_sha.as_deref()).await?;
    Ok(checks.into_iter().map(to_check_info).collect())
}

/// Open a pull request from `branch` into `base`, touching no task.
///
/// The branch is not pushed here. The panel only offers this once the branch is level with its
/// upstream, so a push would be a no-op — and pushing from a command that says it opens a pull
/// request would be a surprise on the one path where the caller was wrong about that.
#[tauri::command]
#[specta::specta]
pub async fn open_pull_request_for_branch(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch: String,
    base: String,
    title: String,
    body: String,
) -> Result<OpenedPullRequest, String> {
    let (config, token, instance_url) = resolve_target(app_state.inner(), project_id).await?;

    if !supports_pull_requests(&config) {
        return Err(format!(
            "Maestro cannot open pull requests on `{}` yet. Push the branch and open it yourself.",
            config.provider
        ));
    }

    let created = create_pull_request(
        &PullRequestTarget {
            config: &config,
            instance_url: instance_url.as_deref(),
            token: &token,
        },
        &branch,
        &base,
        &title,
        &body,
    )
    .await?;

    log::info!("Opened pull request {} from branch {}", created.url, branch);
    Ok(OpenedPullRequest {
        number: created.number,
        url: created.url,
        head_sha: created.head_sha,
    })
}

// The verdict these handlers used to compute is now derived where it is rendered — see `deriveCi`
// in `side-panel/shipActions.ts`, which the card's checks poll feeds directly. `summarise_checks`
// on the Rust side still answers the pipeline's own question and keeps its tests in
// `pull_request.rs`.
