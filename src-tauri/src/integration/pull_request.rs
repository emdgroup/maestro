//! Opening a pull request on the forge that hosts a project's remote.
//!
//! This is deliberately not a git operation. Pushing a branch is; everything past it is not.
//! GitLab's push options are the only git-side route to creating a merge request and they cover
//! exactly one forge, so every provider here goes over HTTP instead — which also means the call
//! runs on the machine running Maestro for every connection type, with nothing to diverge.
//!
//! Kept in one file rather than spread across `providers/`, because the interesting part is the
//! shape they share: one POST, one `{number, url}` back, and four different ways of spelling
//! "source branch".

use serde::Deserialize;

use super::build_http_client;
use crate::models::project::ProjectCodeHostingConfig;

/// Where to open the pull request, and what to authenticate with.
pub struct PullRequestTarget<'a> {
    pub config: &'a ProjectCodeHostingConfig,
    /// Instance URL from the credential that answered, for a self-hosted forge. `None` means the
    /// provider's public host.
    pub instance_url: Option<&'a str>,
    pub token: &'a str,
}

pub struct CreatedPullRequest {
    pub number: i64,
    pub url: String,
}

/// What the forge says has become of a pull request.
///
/// Three values rather than a `merged: bool`, because closed-without-merging is its own outcome
/// and the one the user has to decide about — treating it as "not merged yet" would leave the task
/// waiting forever on a pull request nobody will ever merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

/// What one look at the forge says about a pull request.
///
/// `mergeable` is three-valued on purpose, and `None` means "no answer" rather than "mergeable".
/// GitHub computes the merge commit in the background and returns `null` on the first read after
/// any push; GitLab never answers at all. A conflict has to be positively reported before a task
/// is taken off the forge and handed to a person.
///
/// `head_sha` rides along because the caller needs it to ask about CI, and it arrives in the same
/// response. Fetching it separately was a second identical request per task per sweep.
pub struct PullRequestDetails {
    pub state: PullRequestState,
    pub mergeable: Option<bool>,
    pub head_sha: Option<String>,
}

#[derive(Deserialize)]
struct GitHubStylePullRequest {
    number: i64,
    html_url: String,
}

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: i64,
    web_url: String,
}

/// Open a pull request from `head` into `base`.
///
/// Returns a plain error naming the provider for forges without support yet, rather than a
/// generic failure: "Bitbucket pull requests are not supported yet" is actionable, and the
/// alternative — silently falling back to a local merge — would land work the user asked to have
/// reviewed.
pub async fn create_pull_request(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    match target.config.provider.as_str() {
        "github" => create_github(target, head, base, title, body).await,
        "gitlab" => create_gitlab(target, head, base, title, body).await,
        "gitea" | "forgejo" => create_gitea(target, head, base, title, body).await,
        other => Err(format!(
            "Opening a pull request on `{}` is not supported yet. Push the branch and open it \
             yourself, or merge locally.",
            other
        )),
    }
}

/// Ask the forge what has become of pull request `number`.
///
/// This is the whole of "offline reconciliation": the question is about current state, not about
/// events, so an app that was closed when the PR merged learns the same thing on next launch as
/// one that was watching. There is nothing to replay and no webhook to miss.
pub async fn fetch_pull_request(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetails, String> {
    match target.config.provider.as_str() {
        "github" => {
            let (owner, repo) = owner_repo(target.config)?;
            let url = format!("{}/repos/{}/{}/pulls/{}", github_api_base(target), owner, repo, number);
            let response = build_http_client()?
                .get(url)
                .header("Authorization", format!("Bearer {}", target.token))
                .header("User-Agent", "maestro/1.0")
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;
            let pr: GitHubStyleState = read_json(response, "GitHub").await?;
            Ok(github_style_details(pr))
        }
        "gitlab" => {
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
        "gitea" | "forgejo" => {
            let (owner, repo) = owner_repo(target.config)?;
            let url = format!(
                "{}/api/v1/repos/{}/{}/pulls/{}",
                instance_base(target),
                urlencoding::encode(owner),
                urlencoding::encode(repo),
                number
            );
            let response = build_http_client()?
                .get(url)
                .header("Authorization", format!("token {}", target.token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;
            let pr: GitHubStyleState = read_json(response, "Gitea").await?;
            Ok(github_style_details(pr))
        }
        other => Err(format!("Cannot read pull request state on `{}`.", other)),
    }
}

/// What the forge's CI says about the pull request's head commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CiState {
    /// Everything that ran, passed.
    Passing,
    /// At least one check failed, named so the coder is told what to look at.
    Failing(Vec<String>),
    /// Still running, or queued. Not an answer yet.
    Pending,
    /// No CI configured, or the forge would not say. Never acted on.
    Unknown,
}

/// Ask the forge whether CI is happy with the pull request's head commit.
///
/// Every unclear answer is `Unknown` rather than a guess, because the only thing done with a
/// `Failing` is to start an agent: a misread pending pipeline would spend a round fixing a build
/// that had not finished, and a misread configuration-less repository would spend one forever.
///
/// `head_sha` comes from the caller's `fetch_pull_request` rather than from a request of its own.
/// The sweep asks about CI on every pass now that the card shows it, so fetching the pull request
/// again here would be a second identical GitHub request per task per sweep.
pub async fn fetch_ci_state(
    target: &PullRequestTarget<'_>,
    number: i64,
    head_sha: Option<&str>,
) -> Result<CiState, String> {
    match target.config.provider.as_str() {
        "github" => {
            let Some(sha) = head_sha else {
                return Ok(CiState::Unknown);
            };
            let (owner, repo) = owner_repo(target.config)?;
            let client = build_http_client()?;
            let api = github_api_base(target);
            let auth = format!("Bearer {}", target.token);

            let runs: GitHubCheckRuns = read_json(
                client
                    .get(format!("{}/repos/{}/{}/commits/{}/check-runs", api, owner, repo, sha))
                    .header("Authorization", &auth)
                    .header("User-Agent", "maestro/1.0")
                    .send()
                    .await
                    .map_err(|e| format!("Network error: {}", e))?,
                "GitHub",
            )
            .await?;

            Ok(summarise_check_runs(&runs.check_runs))
        }
        "gitlab" => {
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
        // Gitea and Forgejo expose commit statuses, but the shape has moved between versions and
        // no answer at all is safer here than a wrong one.
        _ => Ok(CiState::Unknown),
    }
}

/// A check run is only a failure once it has a conclusion, and `Pending` beats `Failing` while
/// anything is still going: acting on a half-finished matrix would start a coder on a build that
/// might yet turn green.
fn summarise_check_runs(runs: &[GitHubCheckRun]) -> CiState {
    if runs.is_empty() {
        return CiState::Unknown;
    }
    if runs.iter().any(|run| run.status != "completed") {
        return CiState::Pending;
    }

    let failed: Vec<String> = runs
        .iter()
        .filter(|run| {
            matches!(run.conclusion.as_deref(), Some("failure" | "timed_out" | "action_required"))
        })
        .map(|run| run.name.clone())
        .collect();

    if failed.is_empty() { CiState::Passing } else { CiState::Failing(failed) }
}

#[derive(Deserialize)]
struct GitHubHeadRef {
    sha: String,
}

#[derive(Deserialize)]
struct GitHubCheckRuns {
    check_runs: Vec<GitHubCheckRun>,
}

#[derive(Deserialize)]
struct GitHubCheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
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
struct GitHubStyleState {
    state: String,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    head: Option<GitHubHeadRef>,
}

#[derive(Deserialize)]
struct GitLabState {
    state: String,
}

/// GitHub and Gitea both report a merged PR as `closed` with a separate `merged` flag, so the
/// flag has to be consulted first or every merge would read as a rejection.
fn github_style_details(pr: GitHubStyleState) -> PullRequestDetails {
    let state = if pr.merged {
        PullRequestState::Merged
    } else if pr.state == "closed" {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    };
    PullRequestDetails {
        state,
        mergeable: pr.mergeable,
        head_sha: pr.head.map(|head| head.sha),
    }
}

/// GitHub Enterprise serves the same API under `/api/v3` on the instance itself; github.com
/// serves it from a separate hostname.
fn github_api_base(target: &PullRequestTarget<'_>) -> String {
    match target.instance_url {
        Some(url) if target.config.host != "github.com" => {
            format!("{}/api/v3", super::normalize_instance_url(url))
        }
        _ => "https://api.github.com".to_string(),
    }
}

/// The forge's own base URL, which for a self-hosted instance only the credential knows.
fn instance_base(target: &PullRequestTarget<'_>) -> String {
    match target.instance_url {
        Some(url) => super::normalize_instance_url(url),
        None => format!("https://{}", target.config.host),
    }
}

/// The two fields every forge needs but none of them agrees on: which repository, and where its
/// API lives.
fn owner_repo(config: &ProjectCodeHostingConfig) -> Result<(&str, &str), String> {
    match (config.owner.as_deref(), config.repo.as_deref()) {
        (Some(owner), Some(repo)) => Ok((owner, repo)),
        _ => Err(format!(
            "Could not work out the owner and repository from the remote path `{}`.",
            config.project_path
        )),
    }
}

async fn create_github(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    let (owner, repo) = owner_repo(target.config)?;

    let response = build_http_client()?
        .post(format!("{}/repos/{}/{}/pulls", github_api_base(target), owner, repo))
        .header("Authorization", format!("Bearer {}", target.token))
        .header("User-Agent", "maestro/1.0")
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "title": title, "head": head, "base": base, "body": body }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let created: GitHubStylePullRequest = read_json(response, "GitHub").await?;
    Ok(CreatedPullRequest { number: created.number, url: created.html_url })
}

async fn create_gitlab(
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

async fn create_gitea(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    let (owner, repo) = owner_repo(target.config)?;
    let instance = instance_base(target);

    let response = build_http_client()?
        .post(format!(
            "{}/api/v1/repos/{}/{}/pulls",
            instance,
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        ))
        .header("Authorization", format!("token {}", target.token))
        .json(&serde_json::json!({ "head": head, "base": base, "title": title, "body": body }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let created: GitHubStylePullRequest = read_json(response, "Gitea").await?;
    Ok(CreatedPullRequest { number: created.number, url: created.html_url })
}

/// Deserialise the response, or turn it into an error carrying the forge's own message.
///
/// The body is kept rather than reduced to a status code because the likely failures are ones the
/// user can act on and only if they can read them: "a pull request already exists for this branch"
/// and "no commits between base and head" on creation, a revoked token or a deleted repository on
/// a read.
async fn read_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    provider: &str,
) -> Result<T, String> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("{} refused the request ({}): {}", provider, status, text));
    }

    serde_json::from_str(&text)
        .map_err(|e| format!("{} returned something we could not read: {}", provider, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(body: &str) -> PullRequestDetails {
        github_style_details(serde_json::from_str(body).expect("body should parse"))
    }

    /// GitHub reports a merged PR as `state: "closed"`. Reading the state alone would land every
    /// merged pull request in D28's rejected-PR error path.
    #[test]
    fn a_merged_pull_request_is_not_a_closed_one() {
        assert_eq!(
            details(r#"{"state":"closed","merged":true}"#).state,
            PullRequestState::Merged
        );
        assert_eq!(
            details(r#"{"state":"closed","merged":false}"#).state,
            PullRequestState::Closed
        );
        assert_eq!(details(r#"{"state":"open","merged":false}"#).state, PullRequestState::Open);
    }

    /// GitHub computes the merge commit in the background and answers `null` until it has one,
    /// which is what the first read after every push gets. Reading that as mergeable would hand a
    /// task back to the forge with the conflict still in it; reading it as a conflict would hand
    /// every freshly pushed pull request to the user.
    #[test]
    fn a_pull_request_the_forge_has_not_finished_thinking_about_is_neither() {
        assert_eq!(details(r#"{"state":"open","mergeable":null}"#).mergeable, None);
        assert_eq!(details(r#"{"state":"open","mergeable":false}"#).mergeable, Some(false));
        assert_eq!(details(r#"{"state":"open","mergeable":true}"#).mergeable, Some(true));

        // Gitea omits both fields on older versions, and the sweep has to survive that rather
        // than fail the whole pass on a body it could otherwise read.
        let bare = details(r#"{"state":"open"}"#);
        assert_eq!(bare.mergeable, None);
        assert_eq!(bare.head_sha, None);

        assert_eq!(
            details(r#"{"state":"open","head":{"sha":"deadbeef"}}"#).head_sha.as_deref(),
            Some("deadbeef"),
            "the sha rides along so CI needs no second request"
        );
    }

    fn run(name: &str, status: &str, conclusion: Option<&str>) -> GitHubCheckRun {
        GitHubCheckRun {
            name: name.into(),
            status: status.into(),
            conclusion: conclusion.map(str::to_string),
        }
    }

    /// The only thing done with `Failing` is to start an agent that pushes to an open pull
    /// request, so every unclear answer has to be something else.
    #[test]
    fn only_a_finished_failing_build_is_a_failure() {
        assert_eq!(summarise_check_runs(&[]), CiState::Unknown);

        assert_eq!(
            summarise_check_runs(&[
                run("build", "completed", Some("failure")),
                run("test", "in_progress", None),
            ]),
            CiState::Pending,
            "a matrix still running might yet turn green"
        );

        assert_eq!(
            summarise_check_runs(&[
                run("build", "completed", Some("success")),
                run("lint", "completed", Some("skipped")),
                run("flaky", "completed", Some("neutral")),
            ]),
            CiState::Passing,
            "skipped and neutral are not failures"
        );

        assert_eq!(
            summarise_check_runs(&[
                run("build", "completed", Some("success")),
                run("test", "completed", Some("failure")),
                run("e2e", "completed", Some("timed_out")),
            ]),
            CiState::Failing(vec!["test".into(), "e2e".into()])
        );
    }
}
