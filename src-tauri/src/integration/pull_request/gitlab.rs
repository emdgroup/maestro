//! GitLab merge requests.
//!
//! The only forge here addressed by whole namespace path rather than owner and repository, which
//! is why `project_path` is percent-encoded into every URL instead of being split.

use serde::Deserialize;

use super::{
    CheckStatus, CiState, CreatedPullRequest, ListedPullRequest, PullRequestCheck,
    PullRequestDetail, PullRequestState, PullRequestTarget, instance_base, read_json,
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
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    source_branch: Option<String>,
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct GitLabPipelineState {
    head_pipeline: Option<GitLabPipeline>,
}

#[derive(Deserialize)]
struct GitLabPipeline {
    status: String,
}

/// The merge request endpoint's body, read whole.
///
/// State and the summary fields were two structs read from two calls to this same URL — `ci_gitlab`
/// makes a third. Merging the first two is why the card costs one request here instead of two.
///
/// GitLab reports no line counts and no commit count on the merge request itself: both need
/// separate `/changes` and `/commits` calls, which is more requests than the two lines they would
/// fill are worth. The card simply omits those lines for GitLab.
#[derive(Deserialize)]
struct GitLabDetail {
    state: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    source_branch: Option<String>,
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default)]
    sha: Option<String>,
    /// GitLab's own conflict flag. Absent on older instances, which is why the mapping below
    /// leaves `mergeable` as `None` rather than assuming a missing field means mergeable.
    #[serde(default)]
    has_conflicts: Option<bool>,
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
    Ok(CreatedPullRequest { number: created.iid, url: created.web_url, head_sha: None })
}

pub(super) async fn fetch_gitlab(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetail, String> {
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
    let mr: GitLabDetail = read_json(response, "GitLab").await?;
    Ok(PullRequestDetail {
        state: gitlab_state(&mr.state),
        mergeable: mr.has_conflicts.map(|conflicts| !conflicts),
        head_sha: mr.sha,
        title: mr.title,
        created_at: mr.created_at,
        base_ref: mr.target_branch,
        head_ref: mr.source_branch,
        commits: None,
        changed_files: None,
        additions: None,
        deletions: None,
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

/// `None` for an entry with no source branch: that is the field a worktree is matched on, so an
/// entry without one can neither be linked to a worktree nor checked out into a new one.
fn list_entry_to_listed(entry: GitLabListEntry) -> Option<ListedPullRequest> {
    Some(ListedPullRequest {
        number: entry.iid,
        url: entry.web_url,
        title: entry.title,
        head_branch: entry.source_branch?,
        base_branch: entry.target_branch,
        created_at: entry.created_at,
        head_sha: entry.sha,
    })
}

/// Every merge request in the `opened` state.
///
/// GitLab is the one forge here that names the head branch on its list entry without nesting it, so
/// `source_branch` is read straight off.
pub(super) async fn list_gitlab(
    target: &PullRequestTarget<'_>,
) -> Result<Vec<ListedPullRequest>, String> {
    let url = format!(
        "{}/api/v4/projects/{}/merge_requests?state=opened&order_by=updated_at&sort=desc\
         &per_page=100",
        instance_base(target),
        urlencoding::encode(&target.config.project_path)
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

    Ok(entries.into_iter().filter_map(list_entry_to_listed).collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(body: &str) -> Vec<ListedPullRequest> {
        let entries: Vec<GitLabListEntry> = serde_json::from_str(body).expect("body should parse");
        entries.into_iter().filter_map(list_entry_to_listed).collect()
    }

    /// GitLab names the branches at the top level rather than nesting them, and calls the number
    /// `iid` — the project-scoped one, not the instance-wide `id`, which is what every URL and
    /// every other call here uses.
    #[test]
    fn a_merge_request_maps_onto_the_shared_shape() {
        let listed = listed(
            r#"[{"iid":42,"web_url":"https://gitlab.com/o/r/-/merge_requests/42","title":"Ship it",
                 "state":"opened","sha":"deadbeef","source_branch":"feature","target_branch":"main",
                 "created_at":"2026-09-02T09:00:00Z"}]"#,
        );
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].number, 42);
        assert_eq!(listed[0].head_branch, "feature");
        assert_eq!(listed[0].base_branch.as_deref(), Some("main"));
        assert_eq!(listed[0].head_sha.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn an_entry_with_no_source_branch_is_dropped() {
        assert!(listed(r#"[{"iid":1,"web_url":"u","state":"opened"}]"#).is_empty());
    }
}
