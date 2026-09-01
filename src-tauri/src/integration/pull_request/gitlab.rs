//! GitLab merge requests.
//!
//! The only forge here addressed by whole namespace path rather than owner and repository, which
//! is why `project_path` is percent-encoded into every URL instead of being split.

use serde::Deserialize;

use super::{
    BranchPullRequest, CheckStatus, CiState, CreatedPullRequest, PullRequestCheck,
    PullRequestDetails, PullRequestState, PullRequestTarget, instance_base, read_json,
};
use crate::integration::build_http_client;

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: i64,
    web_url: String,
}

#[derive(Deserialize)]
struct GitLabListEntry {
    iid: i64,
    web_url: String,
    #[serde(default)]
    title: String,
    state: String,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Deserialize)]
struct GitLabPipelineState {
    head_pipeline: Option<GitLabPipeline>,
}

#[derive(Deserialize)]
struct GitLabPipeline {
    status: String,
}

#[derive(Deserialize)]
struct GitLabState {
    state: String,
}

pub(super) async fn create_gitlab(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    let instance = instance_base(target);
    // GitLab addresses a project by its whole namespace path, URL-encoded slashes and all, which
    // is why `project_path` is kept rather than just owner/repo.
    let project = urlencoding::encode(&target.config.project_path);

    let response = build_http_client()?
        .post(format!("{}/api/v4/projects/{}/merge_requests", instance, project))
        .header("PRIVATE-TOKEN", target.token)
        .json(&serde_json::json!({
            "source_branch": head,
            "target_branch": base,
            "title": title,
            "description": body,
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let created: GitLabMergeRequest = read_json(response, "GitLab").await?;
    Ok(CreatedPullRequest { number: created.iid, url: created.web_url })
}

pub(super) async fn fetch_gitlab(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetails, String> {
    let url = format!(
        "{}/api/v4/projects/{}/merge_requests/{}",
        instance_base(target),
        urlencoding::encode(&target.config.project_path),
        number
    );
    let response = build_http_client()?
        .get(url)
        .header("PRIVATE-TOKEN", target.token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let mr: GitLabState = read_json(response, "GitLab").await?;
    Ok(PullRequestDetails {
        state: gitlab_state(&mr.state),
        // GitLab spells this `has_conflicts` on a different shape. Left unread rather than
        // half-read, so a conflict is never inferred from a field nobody parsed.
        mergeable: None,
        head_sha: None,
    })
}

/// GitLab spells "open" as `opened`, and unlike the GitHub family reports a merged merge request
/// with its own state rather than as a closed one carrying a flag. `opened` and `locked` are both
/// still in play, which is why anything unrecognised falls to `Open`.
fn gitlab_state(state: &str) -> PullRequestState {
    match state {
        "merged" => PullRequestState::Merged,
        "closed" => PullRequestState::Closed,
        _ => PullRequestState::Open,
    }
}

fn pick_gitlab_merge_request(mut entries: Vec<GitLabListEntry>) -> Option<BranchPullRequest> {
    if entries.is_empty() {
        return None;
    }
    let index = entries.iter().position(|entry| entry.state == "opened").unwrap_or(0);
    let entry = entries.swap_remove(index);
    Some(BranchPullRequest {
        number: entry.iid,
        url: entry.web_url,
        title: entry.title,
        details: PullRequestDetails {
            state: gitlab_state(&entry.state),
            mergeable: None,
            head_sha: entry.sha,
        },
    })
}

pub(super) async fn find_gitlab(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    let url = format!(
        "{}/api/v4/projects/{}/merge_requests?state=all&order_by=created_at&sort=desc\
         &per_page=20&source_branch={}",
        instance_base(target),
        urlencoding::encode(&target.config.project_path),
        urlencoding::encode(branch)
    );

    let entries: Vec<GitLabListEntry> = read_json(
        build_http_client()?
            .get(url)
            .header("PRIVATE-TOKEN", target.token)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        "GitLab",
    )
    .await?;

    Ok(pick_gitlab_merge_request(entries))
}

/// GitLab answers at the pipeline level, not the job level, so there is exactly one "check" here
/// and it is named for the pipeline rather than invented per job. Listing the jobs would be a
/// second request per poll to split one status the merge request already summarised.
pub(super) async fn checks_gitlab(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<Vec<PullRequestCheck>, String> {
    let status = match ci_gitlab(target, number).await? {
        CiState::Passing => CheckStatus::Passed,
        CiState::Failing(_) => CheckStatus::Failed,
        CiState::Pending => CheckStatus::Running,
        CiState::Unknown => return Ok(Vec::new()),
    };
    Ok(vec![PullRequestCheck { name: "pipeline".to_string(), status }])
}

pub(super) async fn ci_gitlab(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<CiState, String> {
    let response = build_http_client()?
        .get(format!(
            "{}/api/v4/projects/{}/merge_requests/{}",
            instance_base(target),
            urlencoding::encode(&target.config.project_path),
            number
        ))
        .header("PRIVATE-TOKEN", target.token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;
    let mr: GitLabPipelineState = read_json(response, "GitLab").await?;
    Ok(match mr.head_pipeline.map(|pipeline| pipeline.status) {
        Some(status) => match status.as_str() {
            "success" => CiState::Passing,
            "failed" | "canceled" => CiState::Failing(vec![format!("pipeline {}", status)]),
            "running" | "pending" | "created" | "waiting_for_resource" | "preparing"
            | "scheduled" => CiState::Pending,
            _ => CiState::Unknown,
        },
        None => CiState::Unknown,
    })
}
