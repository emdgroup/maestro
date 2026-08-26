//! GitLab merge requests.
//!
//! The only forge here addressed by whole namespace path rather than owner and repository, which
//! is why `project_path` is percent-encoded into every URL instead of being split.

use serde::Deserialize;

use super::{
    CiState, CreatedPullRequest, PullRequestDetails, PullRequestState, PullRequestTarget,
    instance_base, read_json,
};
use crate::integration::build_http_client;

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: i64,
    web_url: String,
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
        state: match mr.state.as_str() {
            "merged" => PullRequestState::Merged,
            "closed" => PullRequestState::Closed,
            // `opened` and `locked` are both still in play.
            _ => PullRequestState::Open,
        },
        // GitLab spells this `has_conflicts` on a different shape. Left unread rather than
        // half-read, so a conflict is never inferred from a field nobody parsed.
        mergeable: None,
        head_sha: None,
    })
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
