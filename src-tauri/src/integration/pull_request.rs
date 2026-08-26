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
    matches!(config.provider.as_str(), "github" | "gitlab" | "gitea" | "forgejo" | "bitbucket")
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
        "bitbucket" => create_bitbucket(target, head, base, title, body).await,
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
        ] {
            assert!(
                supports_pull_requests(&config(provider, host)),
                "{} has an arm in create_pull_request and must be offered",
                provider
            );
        }

        for (provider, host) in [
            ("azuredevops", "dev.azure.com"),
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
}
