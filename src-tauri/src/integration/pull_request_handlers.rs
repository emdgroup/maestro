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
    CheckStatus, CiState, PullRequestCheck, PullRequestState, PullRequestTarget,
    create_pull_request, fetch_ci_checks, find_pull_request_by_head, preferred_credential_base,
    summarise_checks, supports_branch_lookup, supports_pull_requests,
};
use crate::task::models::PullRequestCi;

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

/// The pull request open on a session's branch, as the Overview card renders it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BranchPullRequestInfo {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub state: BranchPullRequestState,
    /// `None` on a forge that will not report CI — Gitea and Forgejo always, and anywhere the
    /// request failed. The card drops its checks block rather than showing a spinner that will
    /// never resolve.
    pub ci: Option<PullRequestCi>,
    /// Names of the checks that failed, and empty unless `ci` is `Failing`. Carried so the panel
    /// can seed a prompt that names them rather than telling the agent to go and look.
    pub failing_checks: Vec<String>,
    /// Every check the forge would name, so the card can show a rollup and the individual rows
    /// rather than repeating the one-word verdict. Empty on a forge that will not enumerate, which
    /// is what the card reads as "no checks block".
    pub checks: Vec<PullRequestCheckInfo>,
}

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

fn ci_summary(state: &CiState) -> (Option<PullRequestCi>, Vec<String>) {
    match state {
        CiState::Passing => (Some(PullRequestCi::Passing), Vec::new()),
        CiState::Pending => (Some(PullRequestCi::Pending), Vec::new()),
        CiState::Failing(checks) => (Some(PullRequestCi::Failing), checks.clone()),
        CiState::Unknown => (None, Vec::new()),
    }
}

fn to_info(
    found: crate::integration::pull_request::BranchPullRequest,
    ci: Option<PullRequestCi>,
    failing_checks: Vec<String>,
    checks: Vec<PullRequestCheck>,
) -> BranchPullRequestInfo {
    BranchPullRequestInfo {
        number: found.number,
        url: found.url,
        title: found.title,
        state: match found.details.state {
            PullRequestState::Open => BranchPullRequestState::Open,
            PullRequestState::Merged => BranchPullRequestState::Merged,
            PullRequestState::Closed => BranchPullRequestState::Closed,
        },
        ci,
        failing_checks,
        checks: checks
            .into_iter()
            .map(|check| PullRequestCheckInfo {
                name: check.name,
                status: match check.status {
                    CheckStatus::Passed => PullRequestCheckStatus::Passed,
                    CheckStatus::Failed => PullRequestCheckStatus::Failed,
                    CheckStatus::Running => PullRequestCheckStatus::Running,
                },
            })
            .collect(),
    }
}

/// The pull request whose head is `branch`, with what CI says about it.
///
/// Polled by the session panel, so every avoidable request matters: CI is only asked for a pull
/// request that is still open, because a merged or closed one's checks change nothing the card
/// shows and would double the request count for every landed branch still on screen.
#[tauri::command]
#[specta::specta]
pub async fn find_branch_pull_request(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch: String,
) -> Result<Option<BranchPullRequestInfo>, String> {
    let (config, token, instance_url) = resolve_target(app_state.inner(), project_id).await?;

    if !supports_branch_lookup(&config) {
        return Err(format!(
            "Maestro cannot look up a pull request by branch on `{}` yet.",
            config.provider
        ));
    }

    let target =
        PullRequestTarget { config: &config, instance_url: instance_url.as_deref(), token: &token };

    let Some(found) = find_pull_request_by_head(&target, &branch).await? else {
        return Ok(None);
    };

    if !matches!(found.details.state, PullRequestState::Open) {
        return Ok(Some(to_info(found, None, Vec::new(), Vec::new())));
    }

    // A CI read that fails must not take the card down with it: the pull request itself was found,
    // and "open, checks unknown" is both true and more useful than an error where the card was.
    let checks =
        match fetch_ci_checks(&target, found.number, found.details.head_sha.as_deref()).await {
            Ok(checks) => checks,
            Err(e) => {
                log::debug!("Could not read CI for pull request #{}: {}", found.number, e);
                Vec::new()
            }
        };

    // Derived from the same list the rows come from rather than fetched separately, so the badge
    // and the rows can never disagree about one pull request.
    let (ci, failing_checks) = ci_summary(&summarise_checks(&checks));

    Ok(Some(to_info(found, ci, failing_checks, checks)))
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
    Ok(OpenedPullRequest { number: created.number, url: created.url })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Unknown` has to reach the card as "no answer" rather than as a fourth badge: it is what a
    /// forge with no CI configured returns, and painting that as pending would leave a spinner on
    /// screen for the life of the pull request.
    #[test]
    fn an_unknown_ci_state_carries_no_verdict() {
        assert!(matches!(ci_summary(&CiState::Unknown), (None, checks) if checks.is_empty()));
        assert!(matches!(ci_summary(&CiState::Passing), (Some(PullRequestCi::Passing), _)));
        assert!(matches!(ci_summary(&CiState::Pending), (Some(PullRequestCi::Pending), _)));
    }

    /// The failing names are the whole point of the seeded prompt — dropping them would leave the
    /// agent to go and find out what broke.
    #[test]
    fn failing_checks_are_named() {
        let (ci, checks) =
            ci_summary(&CiState::Failing(vec!["build".into(), "e2e (windows)".into()]));
        assert!(matches!(ci, Some(PullRequestCi::Failing)));
        assert_eq!(checks, vec!["build", "e2e (windows)"]);
    }
}
