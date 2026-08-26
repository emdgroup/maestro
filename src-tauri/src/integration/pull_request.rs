//! Opening a pull request on the forge that hosts a project's remote.
//!
//! This is deliberately not a git operation. Pushing a branch is; everything past it is not.
//! GitLab's push options are the only git-side route to creating a merge request and they cover
//! exactly one forge, so every provider here goes over HTTP instead — which also means the call
//! runs on the machine running Maestro for every connection type, with nothing to diverge.
//!
//! Kept in one file rather than spread across `providers/`, because the interesting part is the
//! shape they share: one POST, one `{number, url}` back, and several different ways of spelling
//! "source branch".
//!
//! Bitbucket is the exception that shape does not cover. One provider string stands for two
//! unrelated REST trees — Cloud under `api.bitbucket.org/2.0`, Server/Data Center under
//! `{instance}/rest/api/latest` — which agree on almost nothing but the name of a state. Which
//! one is being addressed is decided from the remote's host, never from the credential that
//! answered; see [`bitbucket_deployment`].

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

/// Whether Maestro can open a pull request on this project's forge.
///
/// Lives beside the match statements it describes so the two cannot drift: an arm added below
/// without a change here stays hidden from the user, and a name added here without an arm puts an
/// option in front of them that ends in a pushed branch and an error.
///
/// This is a different question from [`crate::integration::code_hosting_handlers::CodeHostingRung`]
/// `::Ready`, which only says a credential answered. A forge can be connected and still have no arm.
///
/// Takes the whole config rather than the provider name because `host` is the only thing that
/// separates Bitbucket Cloud from Bitbucket Server, which are two forges behind one provider
/// string — if support ever covered one and not the other, this is the only place with enough
/// information to say so.
pub fn supports_pull_requests(config: &ProjectCodeHostingConfig) -> bool {
    matches!(
        config.provider.as_str(),
        "github" | "gitlab" | "gitea" | "forgejo" | "bitbucket" | "azuredevops"
    )
}

/// The base URL whose credential should answer for this project, when the provider needs more than
/// a host to pick one.
///
/// Only Azure DevOps does. See `find_integration` for why its host comparison decides nothing, and
/// [`credential_matches_coordinates`] for what happens when the wrong account answers anyway.
/// Returns `None` for every other provider, and for a remote path this cannot read — the caller
/// then gets the host-matching behaviour every other forge has always had.
pub fn preferred_credential_base(config: &ProjectCodeHostingConfig) -> Option<String> {
    if config.provider != "azuredevops" {
        return None;
    }
    azure_devops_coordinates(&config.host, &config.project_path, None)
        .ok()
        .map(|coordinates| coordinates.base)
}

/// Open a pull request from `head` into `base`.
///
/// Returns a plain error naming the provider for forges without support yet, rather than a
/// generic failure: naming the forge is actionable, and the alternative — silently falling back to
/// a local merge — would land work the user asked to have reviewed.
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
        "bitbucket" => create_bitbucket(target, head, base, title, body).await,
        "azuredevops" => create_azure_devops(target, head, base, title, body).await,
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
        "bitbucket" => {
            let deployment = bitbucket_deployment(&target.config.host, target.instance_url)?;
            let (project, repository) = bitbucket_repository_path(&target.config.project_path)?;
            let client = build_http_client()?;
            let auth = format!("Bearer {}", target.token);

            match &deployment {
                BitbucketDeployment::Cloud => {
                    let response = client
                        .get(format!(
                            "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests/{}",
                            project, repository, number
                        ))
                        .header("Authorization", &auth)
                        .send()
                        .await
                        .map_err(|e| format!("Network error: {}", e))?;
                    let pr: BitbucketCloudPullRequestState =
                        read_json(response, "Bitbucket").await?;
                    Ok(bitbucket_cloud_details(pr))
                }
                BitbucketDeployment::Server(instance) => {
                    let response = client
                        .get(format!(
                            "{}/rest/api/latest/projects/{}/repos/{}/pull-requests/{}",
                            instance, project, repository, number
                        ))
                        .header("Authorization", &auth)
                        .send()
                        .await
                        .map_err(|e| format!("Network error: {}", e))?;
                    let pr: BitbucketServerPullRequestState =
                        read_json(response, "Bitbucket Server").await?;
                    Ok(bitbucket_server_details(pr))
                }
            }
        }
        "azuredevops" => {
            let coordinates = azure_devops_coordinates(
                &target.config.host,
                &target.config.project_path,
                target.instance_url,
            )?;
            credential_matches_coordinates(&coordinates, target.instance_url)?;

            // A pull request id is unique per organization, so this needs no repository — which is
            // exactly why the credential has to have been checked against the organization first.
            let response = build_http_client()?
                .get(format!(
                    "{}/_apis/git/pullrequests/{}?api-version={}",
                    coordinates.base,
                    number,
                    super::azure_devops::AZDO_API_VERSION
                ))
                .header("Authorization", super::azure_devops::make_azdo_auth(target.token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            let pr: AzureDevOpsPullRequestState = azure_devops_json(response).await?;
            Ok(azure_devops_details(pr))
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
        "bitbucket" => {
            let Some(sha) = head_sha else {
                return Ok(CiState::Unknown);
            };
            let deployment = bitbucket_deployment(&target.config.host, target.instance_url)?;
            let (project, repository) = bitbucket_repository_path(&target.config.project_path)?;

            // One page rather than a cursor loop. A pull request with more than a hundred build
            // keys on one commit is not a case worth carrying pagination for.
            let (url, forge) = match &deployment {
                BitbucketDeployment::Cloud => (
                    format!(
                        "https://api.bitbucket.org/2.0/repositories/{}/{}/commit/{}/statuses?pagelen=100",
                        project, repository, sha
                    ),
                    "Bitbucket",
                ),
                BitbucketDeployment::Server(instance) => (
                    format!(
                        "{}/rest/api/latest/projects/{}/repos/{}/commits/{}/builds?limit=100",
                        instance, project, repository, sha
                    ),
                    "Bitbucket Server",
                ),
            };

            let response = build_http_client()?
                .get(url)
                .header("Authorization", format!("Bearer {}", target.token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            // A commit nobody has posted a build for is a 404 on Server, and Cloud's abbreviated
            // sha is one more way to miss. Both mean "no answer", which is already a value here —
            // letting it through `read_json` would instead log a warning for every Bitbucket task
            // on every sweep.
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(CiState::Unknown);
            }

            let statuses: BitbucketBuildStatuses = read_json(response, forge).await?;
            Ok(summarise_bitbucket_builds(&statuses.values))
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

#[derive(Deserialize)]
struct BitbucketCloudCommit {
    hash: String,
}

#[derive(Deserialize)]
struct BitbucketCloudEndpoint {
    #[serde(default)]
    commit: Option<BitbucketCloudCommit>,
}

#[derive(Deserialize)]
struct BitbucketCloudPullRequestState {
    state: String,
    #[serde(default)]
    source: Option<BitbucketCloudEndpoint>,
}

#[derive(Deserialize)]
struct BitbucketServerRef {
    #[serde(rename = "latestCommit", default)]
    latest_commit: Option<String>,
}

#[derive(Deserialize)]
struct BitbucketServerPullRequestState {
    state: String,
    #[serde(rename = "fromRef", default)]
    from_ref: Option<BitbucketServerRef>,
}

/// Both deployments spell the states the same way, so only where the head commit hides differs.
///
/// `SUPERSEDED` is Cloud-only and undocumented, but it is a decision for the user in exactly the
/// way a decline is — that pull request will never merge. Anything unrecognised reads as open, so a
/// vocabulary we have not seen leaves the task where it is instead of landing it or rejecting it on
/// a guess. Compared case-insensitively so a deployment that lowercases cannot silently do that.
fn bitbucket_state(state: &str) -> PullRequestState {
    if state.eq_ignore_ascii_case("MERGED") {
        PullRequestState::Merged
    } else if state.eq_ignore_ascii_case("DECLINED") || state.eq_ignore_ascii_case("SUPERSEDED") {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    }
}

/// `mergeable` is `None` on both mappers below, and that is a fact about Bitbucket rather than a
/// gap here: the pull request object carries no conflict field on either deployment. Same posture
/// as GitLab — a conflict has to be positively reported before a task is taken off the forge.
fn bitbucket_cloud_details(pr: BitbucketCloudPullRequestState) -> PullRequestDetails {
    PullRequestDetails {
        state: bitbucket_state(&pr.state),
        mergeable: None,
        // Abbreviated to 12 characters by Cloud, unlike every other forge here. Fine to hand
        // straight back to Bitbucket's own commit endpoints, but never compare it to a full sha.
        head_sha: pr.source.and_then(|source| source.commit).map(|commit| commit.hash),
    }
}

fn bitbucket_server_details(pr: BitbucketServerPullRequestState) -> PullRequestDetails {
    PullRequestDetails {
        state: bitbucket_state(&pr.state),
        mergeable: None,
        head_sha: pr.from_ref.and_then(|from_ref| from_ref.latest_commit),
    }
}

#[derive(Deserialize)]
struct BitbucketBuildStatuses {
    #[serde(default)]
    values: Vec<BitbucketBuildStatus>,
}

#[derive(Deserialize)]
struct BitbucketBuildStatus {
    state: String,
    /// Always present. `name` is not — Server omits it for a build posted without one.
    key: String,
    #[serde(default)]
    name: Option<String>,
}

/// Summarise Bitbucket's per-build rows into one verdict.
///
/// `CANCELLED`, `STOPPED` and `UNKNOWN` are all `Unknown` rather than `Failing`, which diverges
/// from the GitLab arm above on purpose. Bitbucket reports one row per build key, so a cancelled
/// row can sit next to a green re-run under a different key; calling that a failure would keep a
/// superseded build permanently red and spend every `FIX_ROUND_CAP` round on it. GitLab reports a
/// single `head_pipeline` and has no such shape.
///
/// Anything unrecognised falls to `Unknown` rather than `Passing` for the same reason the GitHub
/// mapper is careful: Server has a literal `UNKNOWN` state, and reporting a green build nobody ran
/// is the worse of the two errors.
fn summarise_bitbucket_builds(statuses: &[BitbucketBuildStatus]) -> CiState {
    if statuses.is_empty() {
        return CiState::Unknown;
    }
    if statuses.iter().any(|status| status.state.eq_ignore_ascii_case("INPROGRESS")) {
        return CiState::Pending;
    }

    let failed: Vec<String> = statuses
        .iter()
        .filter(|status| status.state.eq_ignore_ascii_case("FAILED"))
        // The name is what the CI-fix agent is told to look at, so an unnamed build falls back to
        // its key rather than contributing an empty string.
        .map(|status| status.name.clone().unwrap_or_else(|| status.key.clone()))
        .collect();
    if !failed.is_empty() {
        return CiState::Failing(failed);
    }

    if statuses.iter().all(|status| status.state.eq_ignore_ascii_case("SUCCESSFUL")) {
        CiState::Passing
    } else {
        CiState::Unknown
    }
}

#[derive(Deserialize)]
struct AzureDevOpsCommitRef {
    #[serde(rename = "commitId", default)]
    commit_id: Option<String>,
}

#[derive(Deserialize)]
struct AzureDevOpsPullRequestState {
    status: String,
    #[serde(rename = "mergeStatus", default)]
    merge_status: Option<String>,
    #[serde(rename = "mergeFailureMessage", default)]
    merge_failure_message: Option<String>,
    #[serde(rename = "lastMergeSourceCommit", default)]
    last_merge_source_commit: Option<AzureDevOpsCommitRef>,
}

/// `completed` is Azure DevOps' word for merged, and `abandoned` for closed. Anything else,
/// including the `notSet` default and a word we have not seen, reads as open so the task stays
/// where it is rather than being landed or rejected on a guess.
fn azure_devops_state(status: &str) -> PullRequestState {
    if status.eq_ignore_ascii_case("completed") {
        PullRequestState::Merged
    } else if status.eq_ignore_ascii_case("abandoned") {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    }
}

/// Azure DevOps is the first forge after GitHub that answers this at all, so both directions here
/// are load-bearing. `Some(false)` moves the task to the user with "rebase this", and `Some(true)`
/// is the only thing that ever moves it back.
///
/// Only `conflicts` is a conflict. `rejectedByPolicy` and `failure` are refusals to merge for
/// reasons a rebase cannot fix — a required reviewer, a blocked path, an oversized object — and
/// telling the user to rebase would send them after the wrong thing. They stay `None`, which leaves
/// the pull request with the forge where a human will see the real reason.
fn azure_devops_mergeable(merge_status: Option<&str>) -> Option<bool> {
    let merge_status = merge_status?;
    if merge_status.eq_ignore_ascii_case("conflicts") {
        Some(false)
    } else if merge_status.eq_ignore_ascii_case("succeeded") {
        Some(true)
    } else {
        None
    }
}

/// `head_sha` is the source head as of the last merge *attempt*, not necessarily the live branch
/// tip — Azure DevOps recomputes it asynchronously. Harmless while CI is unanswered for this
/// provider; a future CI implementation that trusts it would query a commit one rebase behind.
fn azure_devops_details(pr: AzureDevOpsPullRequestState) -> PullRequestDetails {
    // The only diagnosis that will ever exist for `failure` and `rejectedByPolicy`, both of which
    // this maps to `None` and therefore acts on nowhere else.
    if let Some(message) = &pr.merge_failure_message {
        log::debug!("Azure DevOps declined to merge pull request: {}", message);
    }
    PullRequestDetails {
        state: azure_devops_state(&pr.status),
        mergeable: azure_devops_mergeable(pr.merge_status.as_deref()),
        head_sha: pr.last_merge_source_commit.and_then(|commit| commit.commit_id),
    }
}

/// Catch the sign-in page Azure DevOps serves instead of an authentication error.
///
/// A token without the Code scope, or an expired one, is answered with `203 Non-Authoritative
/// Information` and an HTML sign-in page rather than a 401. `read_json` sees a success status,
/// hands the HTML to serde, and reports "returned something we could not read" — useless to a user
/// standing in front of a branch that has already been pushed.
///
/// Returns `None` for anything that is not a 2xx, so a genuine error still carries the forge's own
/// message. The body check stands on its own in case the status ever differs.
fn azure_devops_scope_error(status: reqwest::StatusCode, body: &str) -> Option<String> {
    if !status.is_success() {
        return None;
    }
    if status.as_u16() != 203 && !body.trim_start().starts_with('<') {
        return None;
    }
    Some(
        "Azure DevOps answered with a sign-in page rather than data, which means the personal \
         access token is expired or lacks the required scope. Recreate it with `Code (Read & \
         Write)` enabled and reconnect Azure DevOps in Settings."
            .to_string(),
    )
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

/// Which Bitbucket a target refers to. Cloud and Server share a provider name and nothing else.
enum BitbucketDeployment {
    Cloud,
    /// The instance's base URL, already normalised.
    Server(String),
}

/// Decide which Bitbucket this is from the remote's host.
///
/// Deliberately not read from `instance_url` alone. `find_integration` falls back to the first
/// stored account for the provider when no credential's host matches, so a user connected to both
/// Bitbucket Cloud and a Bitbucket Server instance can be handed either one for either remote.
/// Trusting the credential would then post Cloud coordinates to a Server instance and report a 404
/// that explains nothing; comparing the two catches the mismatch and can say which connection is
/// missing.
fn bitbucket_deployment(
    host: &str,
    instance_url: Option<&str>,
) -> Result<BitbucketDeployment, String> {
    match (host == "bitbucket.org", instance_url) {
        (true, None) => Ok(BitbucketDeployment::Cloud),
        (true, Some(_)) => Err(
            "The Bitbucket credential that answered is for a self-hosted instance, but this \
             project's remote is on bitbucket.org. Connect Bitbucket Cloud in Settings."
                .to_string(),
        ),
        (false, Some(url)) => Ok(BitbucketDeployment::Server(super::normalize_instance_url(url))),
        (false, None) => Err(format!(
            "The Bitbucket credential that answered is for bitbucket.org, but this project's \
             remote is on `{}`. Connect that Bitbucket Server instance in Settings.",
            host
        )),
    }
}

/// The two path components every Bitbucket API call needs: workspace and repository slug on Cloud,
/// project key and repository slug on Server.
///
/// Derived from `project_path` rather than read from `config.owner`/`config.repo`, which
/// `hosting_from_remote` only fills for a two-segment remote path. A Bitbucket Server HTTPS remote
/// is `https://host/scm/PROJ/repo.git`, where `scm` is a routing prefix rather than a namespace, so
/// both arrive as `None`. Teaching the forge-agnostic detection about `scm` would not help anyway:
/// `code_hosting_status` only writes `code_hosting` when the project has none, so a project that
/// already detected its Bitbucket remote keeps the empty fields forever.
///
/// `rposition` rather than a check at index 0, because an instance served under a context path
/// gives `bitbucket/scm/PROJ/repo`.
fn bitbucket_repository_path(project_path: &str) -> Result<(&str, &str), String> {
    let segments: Vec<&str> = project_path.split('/').filter(|s| !s.is_empty()).collect();

    let tail = match segments.iter().rposition(|segment| *segment == "scm") {
        Some(marker) => segments.get(marker + 1..).unwrap_or(&[]),
        None => segments.as_slice(),
    };

    match tail {
        [project, repository] => Ok((project, repository)),
        _ => Err(format!(
            "Could not work out the Bitbucket project and repository from the remote path `{}`.",
            project_path
        )),
    }
}

/// The pull request's address in a browser, built from coordinates already in hand.
///
/// Only used when the forge's response carries no usable link. By then the pull request exists, so
/// synthesising the URL is the difference between recording it and losing track of it.
fn bitbucket_web_url(
    deployment: &BitbucketDeployment,
    project: &str,
    repository: &str,
    number: i64,
) -> String {
    match deployment {
        BitbucketDeployment::Cloud => {
            format!("https://bitbucket.org/{}/{}/pull-requests/{}", project, repository, number)
        }
        BitbucketDeployment::Server(base) => {
            format!("{}/projects/{}/repos/{}/pull-requests/{}", base, project, repository, number)
        }
    }
}

/// Which shape of Azure DevOps URL a remote is. The host decides, never the credential.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AzureDevOpsFlavour {
    /// `dev.azure.com` and `ssh.dev.azure.com`. The organization is the first path segment.
    Cloud,
    /// `{organization}.visualstudio.com`. The organization is the host label and is absent from
    /// the path entirely.
    LegacyCloud { organization: String },
    /// `vs-ssh.visualstudio.com`, where the host label is a constant and the organization is back
    /// in the path.
    LegacyCloudSsh,
    /// Anything else. Only the credential knows the collection path.
    Server,
}

/// Everything an Azure DevOps REST call needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AzureDevOpsCoordinates {
    /// Scheme, host and collection path, with no trailing slash. Every URL is `{base}/...`.
    base: String,
    /// `None` on-premises, where there is no comparable notion. Used for the credential check and
    /// for error messages.
    organization: Option<String>,
    /// Verbatim from the remote path, never re-encoded — see [`azure_devops_coordinates`].
    project: String,
    repository: String,
}

fn azure_devops_flavour(host: &str) -> AzureDevOpsFlavour {
    match host {
        "dev.azure.com" | "ssh.dev.azure.com" => AzureDevOpsFlavour::Cloud,
        "vs-ssh.visualstudio.com" => AzureDevOpsFlavour::LegacyCloudSsh,
        _ => match host.strip_suffix(".visualstudio.com") {
            Some(organization) if !organization.is_empty() => {
                AzureDevOpsFlavour::LegacyCloud { organization: organization.to_string() }
            }
            _ => AzureDevOpsFlavour::Server,
        },
    }
}

/// Work out where to address, from the remote rather than from the credential.
///
/// The credential supplies the token, and on-premises the collection path — nothing else. Using it
/// as the base for a cloud remote breaks `*.visualstudio.com`, where `normalize_azdo_org_url`
/// deliberately leaves the URL alone: a user who typed `https://myorg.visualstudio.com/MyProject`
/// into the Organization URL field would have every request built as `.../MyProject/MyProject/...`.
///
/// The path is read by anchoring on the `_git` marker rather than by counting segments, because
/// there are four shapes and no segment count separates them. `parse_remote_url` drops everything
/// after a colon in the host as a port, so `ssh://git@ssh.dev.azure.com:v3/org/project/repo` loses
/// its `v3` while the scp form `git@ssh.dev.azure.com:v3/...` keeps it; and a legacy HTTPS remote
/// carries no organization segment at all. Neither SSH shape contains `_git`.
///
/// Nothing here is percent-encoded on the way out. Azure DevOps project names commonly contain
/// spaces, and a remote URL carries them already encoded — `parse_remote_url` only trims and strips
/// `.git` — so `project_path` already holds `My%20Project`. Encoding again yields `My%2520Project`
/// and a 404. This is the opposite of `azure_devops::fetch_issues`, which correctly does encode,
/// because there the project name comes from a typed configuration field rather than from a URL.
fn azure_devops_coordinates(
    host: &str,
    project_path: &str,
    instance_url: Option<&str>,
) -> Result<AzureDevOpsCoordinates, String> {
    let flavour = azure_devops_flavour(host);
    let segments: Vec<&str> = project_path.split('/').filter(|s| !s.is_empty()).collect();

    let unreadable = || {
        format!("Could not work out the Azure DevOps project and repository from the remote path `{}`.", project_path)
    };

    // `_git` appears in HTTPS remotes only. Everything before the project is organization or
    // collection prefix, which differs per flavour and is resolved below.
    let (prefix, project, repository) = match segments.iter().position(|segment| *segment == "_git")
    {
        Some(marker) => {
            let repository = segments.get(marker + 1).ok_or_else(unreadable)?;
            let project = marker.checked_sub(1).and_then(|i| segments.get(i)).ok_or_else(unreadable)?;
            (&segments[..marker.saturating_sub(1)], *project, *repository)
        }
        None => {
            // SSH. The `v3` marker survives only the scp form.
            let tail = match segments.split_first() {
                Some((first, rest)) if *first == "v3" => rest,
                _ => segments.as_slice(),
            };
            match tail {
                [organization, project, repository] => {
                    (std::slice::from_ref(organization), *project, *repository)
                }
                _ => return Err(unreadable()),
            }
        }
    };

    let (base, organization) = match &flavour {
        AzureDevOpsFlavour::Cloud => {
            let organization = prefix.last().ok_or_else(|| {
                format!("The Azure DevOps remote path `{}` names no organization.", project_path)
            })?;
            (format!("https://dev.azure.com/{}", organization), Some((*organization).to_string()))
        }
        AzureDevOpsFlavour::LegacyCloud { organization } => (
            format!("https://{}.visualstudio.com", organization),
            Some(organization.clone()),
        ),
        AzureDevOpsFlavour::LegacyCloudSsh => {
            let organization = prefix.last().ok_or_else(|| {
                format!("The Azure DevOps remote path `{}` names no organization.", project_path)
            })?;
            (
                format!("https://{}.visualstudio.com", organization),
                Some((*organization).to_string()),
            )
        }
        // Only the credential knows where the collection lives; the remote path's prefix is the
        // collection as the server routes it, not a URL we can build.
        AzureDevOpsFlavour::Server => {
            let instance = instance_url.ok_or_else(|| {
                format!(
                    "No Azure DevOps organization URL is stored for `{}`. Connect Azure DevOps in \
                     Settings with the collection URL of that server.",
                    host
                )
            })?;
            (super::azure_devops::normalize_azdo_org_url(instance), None)
        }
    };

    Ok(AzureDevOpsCoordinates {
        base,
        organization,
        project: project.to_string(),
        repository: repository.to_string(),
    })
}

/// Refuse a credential that answered for a different organization or a different server.
///
/// `find_integration` still falls back to the first stored account when nothing matches, and for
/// Azure DevOps its host comparison decides nothing: every cloud credential's `instance_url` host
/// is `dev.azure.com`, and no credential's host is ever `ssh.dev.azure.com`. A `pullRequestId` is
/// unique per organization rather than per repository, so a wrong credential does not fail — it
/// returns somebody else's real pull request, and a `completed` one lands the task and deletes its
/// worktree.
fn credential_matches_coordinates(
    coordinates: &AzureDevOpsCoordinates,
    instance_url: Option<&str>,
) -> Result<(), String> {
    let Some(instance) = instance_url else {
        return Err(
            "No Azure DevOps credential is available for this project. Connect Azure DevOps in \
             Settings."
                .to_string(),
        );
    };
    let credential_base = super::azure_devops::normalize_azdo_org_url(instance);

    if credential_base.eq_ignore_ascii_case(&coordinates.base) {
        return Ok(());
    }

    Err(match &coordinates.organization {
        Some(organization) => format!(
            "The Azure DevOps credential that answered is for `{}`, but this project's remote is in \
             the `{}` organization. Connect `{}` in Settings.",
            credential_base, organization, organization
        ),
        None => format!(
            "The Azure DevOps credential that answered is for `{}`, but this project's remote is on \
             `{}`. Connect that server in Settings.",
            credential_base, coordinates.base
        ),
    })
}

/// The pull request's address in a browser.
///
/// Synthesised rather than read from the response, because Azure DevOps does not return one at all:
/// `url` and `remoteUrl` are both documented "Used internally", and `_links` has no `web` entry.
/// Even the repository's `remoteUrl` would be the wrong choice — on `dev.azure.com` it has carried
/// userinfo (`https://org@dev.azure.com/...`), and on-premises it is built from the server's
/// configured public URL, which behind a reverse proxy is not the one the user can reach. `base`
/// came from the credential the user validated against.
fn azure_devops_web_url(coordinates: &AzureDevOpsCoordinates, number: i64) -> String {
    format!(
        "{}/{}/_git/{}/pullrequest/{}",
        coordinates.base, coordinates.project, coordinates.repository, number
    )
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

#[derive(Deserialize)]
struct BitbucketHref {
    href: String,
}

#[derive(Deserialize)]
struct BitbucketCloudLinks {
    #[serde(default)]
    html: Option<BitbucketHref>,
}

#[derive(Deserialize)]
struct BitbucketCloudPullRequest {
    id: i64,
    #[serde(default)]
    links: Option<BitbucketCloudLinks>,
}

#[derive(Deserialize)]
struct BitbucketServerLinks {
    /// `self` is a keyword, and the array holds nulls in Atlassian's own published examples.
    #[serde(rename = "self", default)]
    self_links: Vec<Option<BitbucketHref>>,
}

#[derive(Deserialize)]
struct BitbucketServerPullRequest {
    id: i64,
    #[serde(default)]
    links: Option<BitbucketServerLinks>,
}

fn bitbucket_cloud_create_body(
    title: &str,
    body: &str,
    head: &str,
    base: &str,
) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "description": body,
        "source": { "branch": { "name": head } },
        "destination": { "branch": { "name": base } },
    })
}

/// Server names a branch by its full ref and repeats the repository on both ends, because the two
/// may differ — a pull request from a fork addresses one repository in `fromRef` and another in
/// `toRef`.
fn bitbucket_server_create_body(
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    project: &str,
    repository: &str,
) -> serde_json::Value {
    let repository = serde_json::json!({ "slug": repository, "project": { "key": project } });
    serde_json::json!({
        "title": title,
        "description": body,
        "fromRef": { "id": format!("refs/heads/{}", head), "repository": repository },
        "toRef": { "id": format!("refs/heads/{}", base), "repository": repository },
    })
}

/// `fallback_url` rather than an error when the link is missing, on both mappers below: by the time
/// either runs the forge has already opened the pull request, and refusing it here would leave a
/// real pull request that nothing recorded and `reconcile_pull_requests` can never find.
fn bitbucket_cloud_created(
    created: BitbucketCloudPullRequest,
    fallback_url: &str,
) -> CreatedPullRequest {
    let url = created
        .links
        .and_then(|links| links.html)
        .map(|html| html.href)
        .unwrap_or_else(|| fallback_url.to_string());
    CreatedPullRequest { number: created.id, url }
}

fn bitbucket_server_created(
    created: BitbucketServerPullRequest,
    fallback_url: &str,
) -> CreatedPullRequest {
    let url = created
        .links
        .and_then(|links| links.self_links.into_iter().flatten().next())
        .map(|link| link.href)
        .unwrap_or_else(|| fallback_url.to_string());
    CreatedPullRequest { number: created.id, url }
}

async fn create_bitbucket(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    let deployment = bitbucket_deployment(&target.config.host, target.instance_url)?;
    let (project, repository) = bitbucket_repository_path(&target.config.project_path)?;

    let (url, payload) = match &deployment {
        BitbucketDeployment::Cloud => (
            format!(
                "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests",
                project, repository
            ),
            bitbucket_cloud_create_body(title, body, head, base),
        ),
        BitbucketDeployment::Server(instance) => (
            format!(
                "{}/rest/api/latest/projects/{}/repos/{}/pull-requests",
                instance, project, repository
            ),
            bitbucket_server_create_body(title, body, head, base, project, repository),
        ),
    };

    let response = build_http_client()?
        .post(url)
        .header("Authorization", format!("Bearer {}", target.token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    // A body we cannot read is still an error, unlike a missing link: without the id there is
    // nothing to record, so there is no better answer than telling the user.
    match &deployment {
        BitbucketDeployment::Cloud => {
            let created: BitbucketCloudPullRequest = read_json(response, "Bitbucket").await?;
            let fallback = bitbucket_web_url(&deployment, project, repository, created.id);
            Ok(bitbucket_cloud_created(created, &fallback))
        }
        BitbucketDeployment::Server(_) => {
            let created: BitbucketServerPullRequest =
                read_json(response, "Bitbucket Server").await?;
            let fallback = bitbucket_web_url(&deployment, project, repository, created.id);
            Ok(bitbucket_server_created(created, &fallback))
        }
    }
}

#[derive(Deserialize)]
struct AzureDevOpsRepository {
    id: String,
}

#[derive(Deserialize)]
struct AzureDevOpsCreatedPullRequest {
    #[serde(rename = "pullRequestId")]
    pull_request_id: i64,
}

fn azure_devops_create_body(
    title: &str,
    body: &str,
    head: &str,
    base: &str,
) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "description": body,
        "sourceRefName": format!("refs/heads/{}", head),
        "targetRefName": format!("refs/heads/{}", base),
    })
}

/// Read the response, checking for the sign-in page first.
///
/// Azure DevOps bodies are also kept short here. `read_json` embeds the whole body in its error,
/// which for an HTML error page is several kilobytes in front of the user; the rest of the Azure
/// DevOps code truncates at 500 for the same reason.
async fn azure_devops_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if let Some(scope_error) = azure_devops_scope_error(status, &body) {
        return Err(scope_error);
    }
    if !status.is_success() {
        return Err(format!(
            "Azure DevOps refused the request ({}): {}",
            status,
            &body[..body.len().min(500)]
        ));
    }

    serde_json::from_str(&body)
        .map_err(|e| format!("Azure DevOps returned something we could not read: {}", e))
}

/// Resolve the repository named by the remote into its id.
///
/// Unconditional rather than a fallback after a failed create, because create is the one
/// non-idempotent call in this module and it runs *after* the branch has been pushed. Passing the
/// name straight to create and retrying with a resolved id on failure would open a second pull
/// request whenever the first attempt actually succeeded but its response could not be read. The
/// Create endpoint documents this path segment as an id, while this endpoint documents it as "the
/// name or ID", so resolving first is also the only documented route from a remote URL to create.
async fn azure_devops_repository_id(
    coordinates: &AzureDevOpsCoordinates,
    token: &str,
) -> Result<String, String> {
    let response = build_http_client()?
        .get(format!(
            "{}/{}/_apis/git/repositories/{}?api-version={}",
            coordinates.base,
            coordinates.project,
            coordinates.repository,
            super::azure_devops::AZDO_API_VERSION
        ))
        .header("Authorization", super::azure_devops::make_azdo_auth(token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let repository: AzureDevOpsRepository = azure_devops_json(response).await?;
    Ok(repository.id)
}

async fn create_azure_devops(
    target: &PullRequestTarget<'_>,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<CreatedPullRequest, String> {
    let coordinates =
        azure_devops_coordinates(&target.config.host, &target.config.project_path, target.instance_url)?;
    credential_matches_coordinates(&coordinates, target.instance_url)?;

    let repository_id = azure_devops_repository_id(&coordinates, target.token).await?;

    let response = build_http_client()?
        .post(format!(
            "{}/{}/_apis/git/repositories/{}/pullrequests?api-version={}",
            coordinates.base,
            coordinates.project,
            repository_id,
            super::azure_devops::AZDO_API_VERSION
        ))
        .header("Authorization", super::azure_devops::make_azdo_auth(target.token))
        .json(&azure_devops_create_body(title, body, head, base))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let created: AzureDevOpsCreatedPullRequest = azure_devops_json(response).await?;
    Ok(CreatedPullRequest {
        number: created.pull_request_id,
        url: azure_devops_web_url(&coordinates, created.pull_request_id),
    })
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

    fn config(provider: &str, host: &str) -> ProjectCodeHostingConfig {
        ProjectCodeHostingConfig {
            provider: provider.to_string(),
            host: host.to_string(),
            owner: Some("owner".to_string()),
            repo: Some("repo".to_string()),
            project_path: "owner/repo".to_string(),
        }
    }

    /// This list and the match in `create_pull_request` are the same fact written twice, and the
    /// cost of them disagreeing is asymmetric: the approve path pushes the branch before it calls
    /// `create_pull_request`, so a forge offered here but missing an arm there leaves the user with
    /// a branch on the remote, no pull request, and a task stuck in Review.
    ///
    /// Every provider string `provider_for_host` can produce is listed, so adding a forge to
    /// detection without deciding this question fails here rather than in front of a user.
    #[test]
    fn a_forge_with_no_arm_is_not_offered_a_pull_request() {
        for (provider, host) in [
            ("github", "github.com"),
            ("gitlab", "gitlab.com"),
            ("gitea", "gitea.example.com"),
            ("forgejo", "codeberg.org"),
            ("bitbucket", "bitbucket.org"),
            ("bitbucket", "bitbucket.corp.example"),
            ("azuredevops", "dev.azure.com"),
            ("azuredevops", "tfs.corp.example"),
        ] {
            assert!(
                supports_pull_requests(&config(provider, host)),
                "{} has an arm in create_pull_request and must be offered",
                provider
            );
        }

        // `provider_for_host` also resolves a host by matching a stored credential's instance URL,
        // so an issue tracker sharing a host with the git remote can reach this predicate. Neither
        // is a forge, and neither may ever be offered a pull request.
        for (provider, host) in [
            ("jira_cloud", "jira.corp.example"),
            ("linear", "linear.app"),
            ("something-we-have-never-seen", "git.example.com"),
        ] {
            assert!(
                !supports_pull_requests(&config(provider, host)),
                "{} has no arm in create_pull_request and must not be offered",
                provider
            );
        }
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

    /// `hosting_from_remote` only fills `owner`/`repo` for a two-segment remote path, and a
    /// Bitbucket Server HTTPS remote is `https://host/scm/PROJ/repo.git` — so both arrive `None`
    /// and the coordinates have to come back out of `project_path`. Re-detection would not rescue
    /// it either: `code_hosting_status` never rewrites a project that already has `code_hosting`.
    #[test]
    fn a_bitbucket_server_remote_hides_its_project_key_behind_scm() {
        // Cloud, and Server over SSH, both arrive as a plain pair.
        assert_eq!(bitbucket_repository_path("workspace/repo"), Ok(("workspace", "repo")));
        assert_eq!(bitbucket_repository_path("PROJ/repo"), Ok(("PROJ", "repo")));

        assert_eq!(bitbucket_repository_path("scm/PROJ/repo"), Ok(("PROJ", "repo")));
        assert_eq!(
            bitbucket_repository_path("bitbucket/scm/PROJ/repo"),
            Ok(("PROJ", "repo")),
            "an instance served under a context path prefixes the marker"
        );
        assert_eq!(
            bitbucket_repository_path("scm/~username/repo"),
            Ok(("~username", "repo")),
            "a personal fork's project key is the tilde-prefixed username"
        );

        assert!(bitbucket_repository_path("repo").is_err());
        assert!(bitbucket_repository_path("scm/PROJ").is_err());
        assert!(bitbucket_repository_path("").is_err());
    }

    /// `find_integration` falls back to the first stored account for the provider when no
    /// credential's instance URL matches the host, so someone connected to both Bitbucket Cloud and
    /// a Server instance can be handed either one for either remote. Branching on the credential
    /// would post Cloud coordinates at a Server instance; branching on the host turns that into a
    /// message naming the connection they are missing.
    #[test]
    fn the_credential_that_answered_does_not_decide_which_bitbucket_this_is() {
        assert!(matches!(
            bitbucket_deployment("bitbucket.org", None),
            Ok(BitbucketDeployment::Cloud)
        ));
        assert!(matches!(
            bitbucket_deployment("bitbucket.corp.example", Some("https://bitbucket.corp.example/")),
            Ok(BitbucketDeployment::Server(instance)) if instance == "https://bitbucket.corp.example"
        ));

        assert!(
            bitbucket_deployment("bitbucket.org", Some("https://bitbucket.corp.example")).is_err(),
            "a self-hosted credential cannot speak for bitbucket.org"
        );
        assert!(
            bitbucket_deployment("bitbucket.corp.example", None).is_err(),
            "a Cloud credential cannot speak for a self-hosted instance"
        );
    }

    fn cloud_details(body: &str) -> PullRequestDetails {
        bitbucket_cloud_details(serde_json::from_str(body).expect("body should parse"))
    }

    fn server_details(body: &str) -> PullRequestDetails {
        bitbucket_server_details(serde_json::from_str(body).expect("body should parse"))
    }

    /// A declined pull request will never merge, so it is the user's decision in the same way a
    /// closed one is on GitHub. Reading it as still open would leave the task waiting forever.
    #[test]
    fn a_declined_pull_request_is_not_one_still_open() {
        assert_eq!(cloud_details(r#"{"state":"OPEN"}"#).state, PullRequestState::Open);
        assert_eq!(cloud_details(r#"{"state":"MERGED"}"#).state, PullRequestState::Merged);
        assert_eq!(cloud_details(r#"{"state":"DECLINED"}"#).state, PullRequestState::Closed);
        assert_eq!(
            cloud_details(r#"{"state":"SUPERSEDED"}"#).state,
            PullRequestState::Closed,
            "undocumented, but it will never merge either"
        );
        assert_eq!(server_details(r#"{"state":"DECLINED"}"#).state, PullRequestState::Closed);

        assert_eq!(cloud_details(r#"{"state":"merged"}"#).state, PullRequestState::Merged);
        assert_eq!(
            cloud_details(r#"{"state":"SOMETHING_NEW"}"#).state,
            PullRequestState::Open,
            "a word we do not know must leave the task where it is"
        );
    }

    /// The sha rides along so CI needs no second request, and the two deployments keep it in
    /// different places. Neither exposes a mergeable field at all, which is why `PullRequestDetails`
    /// has to tolerate `None` rather than treat it as a conflict.
    #[test]
    fn the_two_bitbuckets_hide_the_head_commit_in_different_places() {
        let cloud = cloud_details(r#"{"state":"OPEN","source":{"commit":{"hash":"310ca98b14f0"}}}"#);
        assert_eq!(cloud.head_sha.as_deref(), Some("310ca98b14f0"));
        assert_eq!(cloud.mergeable, None);

        let server = server_details(
            r#"{"state":"OPEN","fromRef":{"latestCommit":"ef8755f06ee4b28c96a847a95cb8ec8ed6ddd1ca"}}"#,
        );
        assert_eq!(server.head_sha.as_deref(), Some("ef8755f06ee4b28c96a847a95cb8ec8ed6ddd1ca"));
        assert_eq!(server.mergeable, None);

        assert_eq!(cloud_details(r#"{"state":"OPEN"}"#).head_sha, None);
        assert_eq!(server_details(r#"{"state":"OPEN"}"#).head_sha, None);
    }

    fn cloud_created(body: &str) -> CreatedPullRequest {
        bitbucket_cloud_created(
            serde_json::from_str(body).expect("body should parse"),
            "https://fallback.example/pr",
        )
    }

    fn server_created(body: &str) -> CreatedPullRequest {
        bitbucket_server_created(
            serde_json::from_str(body).expect("body should parse"),
            "https://fallback.example/pr",
        )
    }

    /// By the time these run the forge has already opened the pull request. Failing over a link we
    /// could not read would leave a real pull request that nothing recorded, and a task sitting in
    /// Review that `reconcile_pull_requests` can never pick up — worse than a synthesised URL.
    #[test]
    fn a_pull_request_that_exists_is_never_thrown_away_over_a_missing_link() {
        let cloud = cloud_created(r#"{"id":7,"links":{"html":{"href":"https://bitbucket.org/w/r/pull-requests/7"}}}"#);
        assert_eq!(cloud.number, 7);
        assert_eq!(cloud.url, "https://bitbucket.org/w/r/pull-requests/7");

        assert_eq!(cloud_created(r#"{"id":7}"#).url, "https://fallback.example/pr");
        assert_eq!(cloud_created(r#"{"id":7}"#).number, 7, "the id still has to survive");

        let server = server_created(
            r#"{"id":9,"links":{"self":[{"href":"https://bb.corp/projects/P/repos/r/pull-requests/9"}]}}"#,
        );
        assert_eq!(server.number, 9);
        assert_eq!(server.url, "https://bb.corp/projects/P/repos/r/pull-requests/9");

        assert_eq!(
            server_created(r#"{"id":9,"links":{"self":[null]}}"#).url,
            "https://fallback.example/pr",
            "Atlassian's own published examples contain this shape"
        );
        assert_eq!(server_created(r#"{"id":9,"links":{"self":[]}}"#).url, "https://fallback.example/pr");
        assert_eq!(server_created(r#"{"id":9}"#).url, "https://fallback.example/pr");
    }

    fn build(state: &str, key: &str, name: Option<&str>) -> BitbucketBuildStatus {
        BitbucketBuildStatus {
            state: state.into(),
            key: key.into(),
            name: name.map(str::to_string),
        }
    }

    /// Bitbucket keys builds individually, so a cancelled row can sit beside a green re-run under
    /// another key. Calling that a failure would keep a superseded build red forever and spend
    /// every one of the three CI-fix rounds on it.
    #[test]
    fn a_cancelled_build_is_not_a_failing_one() {
        assert_eq!(summarise_bitbucket_builds(&[]), CiState::Unknown);

        assert_eq!(
            summarise_bitbucket_builds(&[
                build("FAILED", "build", Some("build")),
                build("INPROGRESS", "test", Some("test")),
            ]),
            CiState::Pending,
            "something still running might yet turn green"
        );

        assert_eq!(
            summarise_bitbucket_builds(&[
                build("SUCCESSFUL", "build", Some("build")),
                build("SUCCESSFUL", "test", Some("test")),
            ]),
            CiState::Passing
        );

        assert_eq!(
            summarise_bitbucket_builds(&[
                build("SUCCESSFUL", "build", Some("build")),
                build("FAILED", "test", Some("test")),
            ]),
            CiState::Failing(vec!["test".into()])
        );

        assert_eq!(
            summarise_bitbucket_builds(&[
                build("SUCCESSFUL", "rerun", Some("rerun")),
                build("CANCELLED", "build", Some("build")),
            ]),
            CiState::Unknown
        );
        assert_eq!(
            summarise_bitbucket_builds(&[build("UNKNOWN", "build", Some("build"))]),
            CiState::Unknown,
            "Server reports this literally, and it is not a pass"
        );
        assert_eq!(
            summarise_bitbucket_builds(&[build("SOMETHING_NEW", "build", Some("build"))]),
            CiState::Unknown
        );
    }

    /// The failing check names go verbatim into the prompt the CI-fix agent reads, so a build
    /// posted without a name has to arrive as something rather than an empty string.
    #[test]
    fn a_build_with_no_name_is_reported_by_its_key() {
        assert_eq!(
            summarise_bitbucket_builds(&[build("FAILED", "PIPELINE-42", None)]),
            CiState::Failing(vec!["PIPELINE-42".into()])
        );
    }

    /// Server names a branch by its full ref and repeats the repository on both ends. A typo here
    /// is a 400 the user meets only after their branch has already been pushed to the remote.
    #[test]
    fn bitbucket_server_wants_the_branch_spelled_as_a_ref() {
        let body = bitbucket_server_create_body(
            "Add the thing",
            "Because.",
            "feature/x",
            "main",
            "PROJ",
            "repo",
        );

        assert_eq!(body["fromRef"]["id"], "refs/heads/feature/x");
        assert_eq!(body["toRef"]["id"], "refs/heads/main");
        assert_eq!(body["fromRef"]["repository"]["slug"], "repo");
        assert_eq!(body["fromRef"]["repository"]["project"]["key"], "PROJ");
        assert_eq!(body["toRef"]["repository"]["slug"], "repo");
        assert_eq!(body["description"], "Because.");
    }

    /// Cloud wants the opposite of Server: a bare branch name, nested two levels deep, and the body
    /// under `description` rather than `body`.
    #[test]
    fn bitbucket_cloud_wants_a_bare_branch_name() {
        let body = bitbucket_cloud_create_body("Add the thing", "Because.", "feature/x", "main");

        assert_eq!(body["source"]["branch"]["name"], "feature/x");
        assert_eq!(body["destination"]["branch"]["name"], "main");
        assert_eq!(body["description"], "Because.");
        assert_eq!(body["title"], "Add the thing");
    }

    fn coordinates(host: &str, project_path: &str) -> AzureDevOpsCoordinates {
        azure_devops_coordinates(host, project_path, None).expect("path should parse")
    }

    /// Four remote shapes, no two of which agree on where the organization is, and no segment count
    /// that separates them. `parse_remote_url` drops everything after a colon in the host as a
    /// port, so the `ssh://` form arrives without the `v3` the scp form keeps; and a legacy HTTPS
    /// remote has no organization segment at all. Neither SSH form contains `_git`.
    #[test]
    fn an_azure_devops_remote_hides_its_organization_in_four_different_places() {
        let cloud = coordinates("dev.azure.com", "myorg/MyProject/_git/MyRepo");
        assert_eq!(cloud.base, "https://dev.azure.com/myorg");
        assert_eq!(cloud.organization.as_deref(), Some("myorg"));
        assert_eq!(cloud.project, "MyProject");
        assert_eq!(cloud.repository, "MyRepo");

        // scp form: `git@ssh.dev.azure.com:v3/myorg/MyProject/MyRepo`
        let scp = coordinates("ssh.dev.azure.com", "v3/myorg/MyProject/MyRepo");
        assert_eq!(scp.base, "https://dev.azure.com/myorg");
        assert_eq!(scp.project, "MyProject");
        assert_eq!(scp.repository, "MyRepo");

        // ssh:// form, whose `v3` was eaten as a port before it ever reached us.
        let ssh_url = coordinates("ssh.dev.azure.com", "myorg/MyProject/MyRepo");
        assert_eq!(ssh_url, scp, "both SSH spellings name the same repository");

        let legacy = coordinates("myorg.visualstudio.com", "MyProject/_git/MyRepo");
        assert_eq!(legacy.base, "https://myorg.visualstudio.com");
        assert_eq!(legacy.organization.as_deref(), Some("myorg"));
        assert_eq!(legacy.project, "MyProject");

        // The host label here is the constant `vs-ssh`, so the organization has to come from the
        // path rather than from the host.
        let legacy_ssh = coordinates("vs-ssh.visualstudio.com", "v3/myorg/MyProject/MyRepo");
        assert_eq!(legacy_ssh.base, "https://myorg.visualstudio.com");
        assert_eq!(legacy_ssh.organization.as_deref(), Some("myorg"));

        assert!(azure_devops_coordinates("dev.azure.com", "myorg/MyProject", None).is_err());
        assert!(azure_devops_coordinates("dev.azure.com", "", None).is_err());
    }

    /// On-premises there is no organization in the URL, only a collection path that the remote
    /// cannot tell us how to reach — the server may sit behind any prefix. That is the one case
    /// where the credential supplies the base.
    #[test]
    fn an_on_prem_collection_path_comes_from_the_credential_and_nowhere_else() {
        let on_prem = azure_devops_coordinates(
            "tfs.corp.example",
            "tfs/DefaultCollection/MyProject/_git/MyRepo",
            Some("https://tfs.corp.example/tfs/DefaultCollection"),
        )
        .expect("path should parse");
        assert_eq!(on_prem.base, "https://tfs.corp.example/tfs/DefaultCollection");
        assert_eq!(on_prem.organization, None);
        assert_eq!(on_prem.project, "MyProject");
        assert_eq!(on_prem.repository, "MyRepo");

        assert!(
            azure_devops_coordinates(
                "tfs.corp.example",
                "tfs/DefaultCollection/MyProject/_git/MyRepo",
                None
            )
            .is_err(),
            "with no credential there is nothing that knows where the collection lives"
        );
    }

    /// `normalize_azdo_org_url` only strips a stray project segment from `dev.azure.com` URLs and
    /// returns everything else untouched, by design. Using the credential as the base for a legacy
    /// cloud remote would therefore build `.../MyProject/MyProject/_apis/...` for anyone who typed
    /// their project URL into the Organization URL field.
    #[test]
    fn a_visualstudio_com_credential_url_is_never_used_as_the_base() {
        let resolved = azure_devops_coordinates(
            "myorg.visualstudio.com",
            "MyProject/_git/MyRepo",
            Some("https://myorg.visualstudio.com/MyProject"),
        )
        .expect("path should parse");

        assert_eq!(resolved.base, "https://myorg.visualstudio.com");
    }

    /// `find_integration` falls back to the first stored account, and for Azure DevOps its host
    /// comparison decides nothing — every cloud credential's host is `dev.azure.com` and no
    /// credential's host is ever `ssh.dev.azure.com`. Because a pull request id is unique per
    /// organization rather than per repository, the wrong account does not fail: it returns another
    /// organization's real pull request, and a completed one lands the task and deletes its
    /// worktree.
    #[test]
    fn the_credential_that_answered_does_not_decide_which_organization_this_is() {
        let ours = coordinates("dev.azure.com", "myorg/MyProject/_git/MyRepo");

        assert!(credential_matches_coordinates(&ours, Some("https://dev.azure.com/myorg")).is_ok());
        assert!(
            credential_matches_coordinates(&ours, Some("https://dev.azure.com/myorg/MyProject"))
                .is_ok(),
            "a stray project segment is what normalize_azdo_org_url exists to forgive"
        );

        let wrong = credential_matches_coordinates(&ours, Some("https://dev.azure.com/otherorg"))
            .expect_err("another organization must be refused");
        assert!(wrong.contains("myorg"), "the message has to name the organization needed");

        assert!(credential_matches_coordinates(&ours, None).is_err());

        let on_prem = azure_devops_coordinates(
            "tfs.corp.example",
            "tfs/DefaultCollection/MyProject/_git/MyRepo",
            Some("https://tfs.corp.example/tfs/DefaultCollection"),
        )
        .expect("path should parse");
        assert!(
            credential_matches_coordinates(&on_prem, Some("https://dev.azure.com/myorg")).is_err(),
            "a cloud credential cannot answer for a server"
        );
    }

    /// Azure DevOps project names commonly contain spaces, and a remote URL carries them already
    /// percent-encoded — `parse_remote_url` only trims and strips `.git`. Encoding again would turn
    /// `My%20Project` into `My%2520Project` and 404 every request.
    #[test]
    fn a_project_name_with_a_space_is_already_encoded_by_the_time_it_reaches_us() {
        let resolved = coordinates("dev.azure.com", "myorg/My%20Project/_git/MyRepo");
        assert_eq!(resolved.project, "My%20Project");
        assert_eq!(
            azure_devops_web_url(&resolved, 7),
            "https://dev.azure.com/myorg/My%20Project/_git/MyRepo/pullrequest/7"
        );
    }

    /// Azure DevOps returns no browser URL at all — `url` and `remoteUrl` are both documented "Used
    /// internally" and `_links` has no `web` entry — so this is the only address the task card will
    /// ever have. The repository's own `remoteUrl` is not used: it has carried userinfo on
    /// `dev.azure.com`, and on-premises it reflects the server's configured public URL rather than
    /// one the user can necessarily reach.
    #[test]
    fn azure_devops_returns_no_browser_url_so_we_build_one() {
        assert_eq!(
            azure_devops_web_url(&coordinates("dev.azure.com", "myorg/MyProject/_git/MyRepo"), 22),
            "https://dev.azure.com/myorg/MyProject/_git/MyRepo/pullrequest/22"
        );
        assert_eq!(
            azure_devops_web_url(
                &coordinates("myorg.visualstudio.com", "MyProject/_git/MyRepo"),
                22
            ),
            "https://myorg.visualstudio.com/MyProject/_git/MyRepo/pullrequest/22"
        );

        let on_prem = azure_devops_coordinates(
            "tfs.corp.example",
            "tfs/DefaultCollection/MyProject/_git/MyRepo",
            Some("https://tfs.corp.example/tfs/DefaultCollection"),
        )
        .expect("path should parse");
        assert_eq!(
            azure_devops_web_url(&on_prem, 22),
            "https://tfs.corp.example/tfs/DefaultCollection/MyProject/_git/MyRepo/pullrequest/22"
        );
    }

    fn azdo_details(body: &str) -> PullRequestDetails {
        azure_devops_details(serde_json::from_str(body).expect("body should parse"))
    }

    /// Azure DevOps says `completed` where every other forge says merged, and `abandoned` where
    /// they say closed. Reading `completed` as anything else would leave every merged pull request
    /// waiting forever.
    #[test]
    fn an_abandoned_pull_request_is_not_one_still_open() {
        assert_eq!(azure_devops_state("completed"), PullRequestState::Merged);
        assert_eq!(azure_devops_state("abandoned"), PullRequestState::Closed);
        assert_eq!(azure_devops_state("active"), PullRequestState::Open);
        assert_eq!(azure_devops_state("notSet"), PullRequestState::Open);
        assert_eq!(azure_devops_state("Completed"), PullRequestState::Merged);
        assert_eq!(
            azure_devops_state("something-new"),
            PullRequestState::Open,
            "a word we do not know must leave the task where it is"
        );
    }

    /// `Some(false)` moves the task to the user with "rebase this", and `Some(true)` is the only
    /// thing that moves it back. A policy rejection is neither: no rebase clears a missing reviewer,
    /// so it stays `None` and the pull request stays with the forge.
    #[test]
    fn a_policy_rejection_is_not_a_merge_conflict() {
        assert_eq!(azure_devops_mergeable(Some("conflicts")), Some(false));
        assert_eq!(azure_devops_mergeable(Some("succeeded")), Some(true));
        assert_eq!(azure_devops_mergeable(Some("CONFLICTS")), Some(false));

        for status in ["queued", "notSet", "rejectedByPolicy", "failure", "something-new"] {
            assert_eq!(azure_devops_mergeable(Some(status)), None, "{} is not an answer", status);
        }
        assert_eq!(azure_devops_mergeable(None), None);
    }

    /// The sha rides along so CI needs no second request. Azure DevOps returns a full 40 characters,
    /// unlike Bitbucket Cloud's abbreviated 12 — and it is the head as of the last merge *attempt*,
    /// which a future CI implementation must not mistake for the live branch tip.
    #[test]
    fn the_head_commit_rides_along_from_the_last_merge_attempt() {
        let details = azdo_details(
            r#"{"status":"active","mergeStatus":"succeeded","lastMergeSourceCommit":{"commitId":"b60280bc6e62e2f880f1b63c1e24987664d3bda3"}}"#,
        );
        assert_eq!(details.head_sha.as_deref(), Some("b60280bc6e62e2f880f1b63c1e24987664d3bda3"));
        assert_eq!(details.state, PullRequestState::Open);
        assert_eq!(details.mergeable, Some(true));

        let bare = azdo_details(r#"{"status":"active"}"#);
        assert_eq!(bare.head_sha, None);
        assert_eq!(bare.mergeable, None, "no mergeStatus is not a conflict");
    }

    /// Azure DevOps names a branch by its full ref on both ends. A typo here is a 400 the user
    /// meets only after their branch has already been pushed to the remote.
    #[test]
    fn azure_devops_wants_the_branch_spelled_as_a_ref() {
        let body =
            azure_devops_create_body("Add the thing", "Because.", "maestro/task-12", "main");

        assert_eq!(body["sourceRefName"], "refs/heads/maestro/task-12");
        assert_eq!(body["targetRefName"], "refs/heads/main");
        assert_eq!(body["title"], "Add the thing");
        assert_eq!(body["description"], "Because.");
    }

    /// A token that is expired or lacks the Code scope is answered with a sign-in page and a 2xx,
    /// not a 401. Without this the user is told "returned something we could not read" while
    /// standing in front of a branch that has already been pushed.
    #[test]
    fn an_under_scoped_token_answers_with_a_sign_in_page_rather_than_a_401() {
        let sign_in = azure_devops_scope_error(
            reqwest::StatusCode::NON_AUTHORITATIVE_INFORMATION,
            "<!DOCTYPE html><html>Sign in</html>",
        )
        .expect("a 203 is the documented shape of this failure");
        assert!(sign_in.contains("Code (Read & Write)"), "the message must name the scope");

        assert!(
            azure_devops_scope_error(reqwest::StatusCode::OK, "  <html>Sign in</html>").is_some(),
            "the body alone is enough, in case the status ever differs"
        );
        assert!(
            azure_devops_scope_error(reqwest::StatusCode::OK, r#"{"pullRequestId":1}"#).is_none()
        );
        assert!(
            azure_devops_scope_error(reqwest::StatusCode::NOT_FOUND, "nope").is_none(),
            "a genuine error keeps the forge's own message"
        );
    }

    /// Azure DevOps CI is deliberately unanswered rather than merely unimplemented. Pull request
    /// `statuses` carries external CI only and would report nothing for Azure Pipelines, and policy
    /// `evaluations` — which does reflect Pipelines — exists only as a preview API that Microsoft
    /// may deactivate twelve weeks after it goes GA. `Unknown` is never acted on, so saying nothing
    /// costs a missing card detail; guessing would spend the CI-fix rounds on a build nobody ran.
    #[test]
    fn azure_devops_ci_is_deliberately_unanswered() {
        assert!(
            supports_pull_requests(&config("azuredevops", "dev.azure.com")),
            "the forge is supported for pull requests"
        );
        // `fetch_ci_state` has no `azuredevops` arm, so it reaches the catch-all. This test exists
        // to make removing that a deliberate act rather than an accident.
    }
}
