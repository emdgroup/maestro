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
use crate::integration::code_hosting_handlers::{code_hosting_status, CodeHostingRung};
use crate::integration::issue_tracking_handlers::find_integration;
use crate::integration::pull_request::{
    create_pull_request, fetch_branch_pull_request as fetch_branch_pull_request_on_forge,
    fetch_row_detail, finds_pull_request_by_branch, list_open_pull_requests,
    preferred_credential_base, supports_pull_request_list, supports_pull_requests, CheckStatus,
    CiRollup, ListedPullRequest, ListedPullRequestDetail, PullRequestCheck, PullRequestState,
    PullRequestTarget,
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

/// One open pull request, as the Worktrees view's panel reads it.
///
/// No state, because every entry here is open by definition.
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
    /// Part of the key the frontend holds `detail` under. `head_sha` alone would miss a CI run that
    /// started or finished without a new commit, and the row would keep its first answer forever.
    pub updated_at: Option<String>,
    /// Whether the head branch is in a fork rather than in this project's own repository, which
    /// decides how the row checks itself out — and, on a forge that publishes no head ref, whether
    /// it can be checked out at all. See [`ListedPullRequest::from_fork`] for why an unanswered
    /// question is `true`.
    pub from_fork: bool,
    /// `None` means *unasked*, and is the caller's signal to fetch it for this row with
    /// [`fetch_pull_request_row_detail`]. GitHub fills it here from the same GraphQL request that
    /// produced the row, so on GitHub that command is never called at all.
    pub detail: Option<PullRequestRowDetail>,
}

/// The line counts, file count and CI verdict a row shows.
///
/// The same shape whether it arrived inside the list or from the per-row command, so the frontend
/// has one type for "what this row knows" and no branch on where it came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PullRequestRowDetail {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub changed_files: Option<i64>,
    pub ci: PullRequestCiRollup,
}

/// A row's CI as one mark.
///
/// Mirrors [`CiRollup`]. A verdict rather than a list of names, because naming the checks is what
/// made the query this replaces cost a hundred times as much — and a row draws one coloured icon.
/// Names are still read where they are shown: the session panel and the worktree card chip both ask
/// about a single branch and get the full list.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum PullRequestCiRollup {
    Passing,
    Failing,
    Running,
    Unknown,
}

/// One page of a project's open pull requests.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PullRequestPageInfo {
    pub items: Vec<ProjectPullRequest>,
    /// Pass back verbatim to ask for the next page. Opaque — a GraphQL cursor on GitHub, a row
    /// offset elsewhere — and `None` when there is no next page.
    pub next_cursor: Option<String>,
    /// How many are open in total, where the forge says so cheaply. `None` on Bitbucket Server and
    /// Azure DevOps, whose responses carry no total at all; the header then reports how many it is
    /// showing rather than inventing a denominator.
    pub total: Option<i64>,
}

/// The pull request on a session's branch, whole.
///
/// One shape because it is one question and, on GitHub, one request. Detection, state and CI were
/// three queries at three rates until measuring showed a single-pull-request GraphQL call carrying
/// all of it costs one point — and that splitting them is what let the card's header and its check
/// ring describe two different moments.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BranchPullRequestInfo {
    pub number: i64,
    pub url: String,
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
    /// `false` is a conflict to resolve; `None` is the forge still computing the merge commit.
    pub mergeable: Option<bool>,
    /// Empty on a forge that names no checks, and for a pull request that has already landed.
    pub checks: Vec<PullRequestCheckInfo>,
}

/// Resolve the forge and a credential for it, or say which of the two is missing.
///
/// Both commands below need exactly this and the messages are the user's only route out of the
/// failure, so they are written once here rather than drifting apart in two places.
async fn resolve_target(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<
    (
        crate::models::project::ProjectCodeHostingConfig,
        String,
        Option<String>,
    ),
    String,
> {
    let status = code_hosting_status(app_state, project_id).await?;
    let Some(config) = status.config else {
        return Err(match status.rung {
            CodeHostingRung::NoRemote => {
                "This project has no git remote, so there is no forge to ask.".to_string()
            }
            _ => "This project's remote is not on a forge Maestro recognises.".to_string(),
        });
    };

    let integration = find_integration(
        &config.provider,
        &config.host,
        preferred_credential_base(&config).as_deref(),
        app_state,
    )
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

fn to_row_detail(detail: ListedPullRequestDetail) -> PullRequestRowDetail {
    PullRequestRowDetail {
        additions: detail.additions,
        deletions: detail.deletions,
        changed_files: detail.changed_files,
        ci: match detail.ci {
            CiRollup::Passing => PullRequestCiRollup::Passing,
            CiRollup::Failing => PullRequestCiRollup::Failing,
            CiRollup::Running => PullRequestCiRollup::Running,
            CiRollup::Unknown => PullRequestCiRollup::Unknown,
        },
    }
}

fn to_project_pull_request(entry: ListedPullRequest) -> ProjectPullRequest {
    ProjectPullRequest {
        number: entry.number,
        url: entry.url,
        title: entry.title,
        head_branch: entry.head_branch,
        base_branch: entry.base_branch,
        created_at: entry.created_at,
        head_sha: entry.head_sha,
        updated_at: entry.updated_at,
        from_fork: entry.from_fork,
        detail: entry.detail.map(to_row_detail),
    }
}

/// One page of the pull requests open on the project's forge.
///
/// A page, never the whole list — `nixpkgs` has around eleven thousand open at once, so every answer
/// this could give is a page and the only real choice is whether the caller is told which one. It is
/// told: `total` and `next_cursor` come back with the rows.
///
/// `search` is handed to the forge rather than applied here. Filtering thirty rows out of eleven
/// thousand finds almost nothing and looks like an empty project, so a forge that cannot search
/// says so through `forge_searches_pull_requests` and the panel shows no box at all.
///
/// Answers an empty page rather than an error when the project has no forge or no credential: a
/// project that never connected one should show no pull requests, not an error strip over a view
/// that works perfectly well without them.
#[tauri::command]
#[specta::specta]
pub async fn list_project_pull_requests(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    cursor: Option<String>,
    search: Option<String>,
) -> Result<PullRequestPageInfo, String> {
    let empty = PullRequestPageInfo {
        items: Vec::new(),
        next_cursor: None,
        total: None,
    };

    let Ok((config, token, instance_url)) = resolve_target(app_state.inner(), project_id).await
    else {
        return Ok(empty);
    };

    if !supports_pull_request_list(&config) {
        return Ok(empty);
    }

    let target = PullRequestTarget {
        config: &config,
        instance_url: instance_url.as_deref(),
        token: &token,
    };

    // A blank box is not a search. Passing one through would ask GitHub for `is:pr is:open` with a
    // trailing space and rank by relevance, quietly reordering the list the moment the user clears
    // what they typed.
    let term = search
        .as_deref()
        .map(str::trim)
        .filter(|term| !term.is_empty());

    let page = list_open_pull_requests(&target, cursor.as_deref(), term).await?;
    Ok(PullRequestPageInfo {
        items: page
            .items
            .into_iter()
            .map(to_project_pull_request)
            .collect(),
        next_cursor: page.next_cursor,
        total: page.total,
    })
}

/// The counts and CI verdict for one row whose list entry did not carry them.
///
/// Called once per pull request, when it is first seen, and then held against
/// `(number, head_sha, updated_at)` — so the steady-state cost of a page is zero and only a new
/// pull request, a push, or a CI transition pays for anything.
///
/// Never called on GitHub, whose list request answers this for free, and never on Bitbucket or Azure
/// DevOps, whose rows arrive with an empty answer rather than an absent one precisely so that
/// nothing asks.
#[tauri::command]
#[specta::specta]
pub async fn fetch_pull_request_row_detail(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    number: i64,
    head_sha: Option<String>,
) -> Result<PullRequestRowDetail, String> {
    let (config, token, instance_url) = resolve_target(app_state.inner(), project_id).await?;
    let target = PullRequestTarget {
        config: &config,
        instance_url: instance_url.as_deref(),
        token: &token,
    };

    Ok(to_row_detail(
        fetch_row_detail(&target, number, head_sha.as_deref()).await?,
    ))
}

/// The whole session card for one branch: which pull request, what state, and its checks.
///
/// Asked by branch on every poll rather than detected once and then tracked by number. That is what
/// makes coming back to a session pick up a `#10` that was closed and replaced by a `#11` somebody
/// opened on the forge, with no second query and no remembered number to go stale.
///
/// Deliberately *not* the project-wide open list. That list is one page of a repository which may
/// have eleven thousand open pull requests, so a session's own drops off it whenever colleagues are
/// busier than the user — and a branch missing from a page is indistinguishable from a branch with
/// no pull request. This asks about one branch and is exact at any project size.
///
/// `Ok(None)` for a project with no forge or no credential, and for a forge that cannot be asked:
/// a session that never connected one should show no card, not an error strip on a 30-second timer.
#[tauri::command]
#[specta::specta]
pub async fn fetch_branch_pull_request(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branch: String,
) -> Result<Option<BranchPullRequestInfo>, String> {
    let Ok((config, token, instance_url)) = resolve_target(app_state.inner(), project_id).await
    else {
        return Ok(None);
    };

    if !finds_pull_request_by_branch(&config) {
        return Ok(None);
    }

    let target = PullRequestTarget {
        config: &config,
        instance_url: instance_url.as_deref(),
        token: &token,
    };

    let Some(found) = fetch_branch_pull_request_on_forge(&target, &branch).await? else {
        return Ok(None);
    };

    Ok(Some(BranchPullRequestInfo {
        number: found.number,
        url: found.url,
        state: match found.detail.state {
            PullRequestState::Open => BranchPullRequestState::Open,
            PullRequestState::Merged => BranchPullRequestState::Merged,
            PullRequestState::Closed => BranchPullRequestState::Closed,
        },
        title: found.detail.title,
        base_branch: found.detail.base_ref,
        head_branch: found.detail.head_ref,
        head_sha: found.detail.head_sha,
        created_at: found.detail.created_at,
        commits: found.detail.commits,
        changed_files: found.detail.changed_files,
        additions: found.detail.additions,
        deletions: found.detail.deletions,
        mergeable: found.detail.mergeable,
        checks: found.checks.into_iter().map(to_check_info).collect(),
    }))
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
