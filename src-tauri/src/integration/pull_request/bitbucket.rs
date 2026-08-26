//! Bitbucket Cloud and Bitbucket Server / Data Center.
//!
//! One provider string stands for two unrelated REST trees — Cloud under
//! `api.bitbucket.org/2.0`, Server under `{instance}/rest/api/latest` — which agree on almost
//! nothing but the name of a state. Which one is being addressed is decided from the remote's
//! host, never from the credential that answered; see [`bitbucket_deployment`].

use serde::Deserialize;

use super::{
    CiState, CreatedPullRequest, PullRequestDetails, PullRequestState, PullRequestTarget, read_json,
};
use crate::integration::{build_http_client, normalize_instance_url};

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
        (false, Some(url)) => Ok(BitbucketDeployment::Server(normalize_instance_url(url))),
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
/// from `super::gitlab`'s mapper on purpose. Bitbucket reports one row per build key, so a
/// cancelled row can sit next to a green re-run under a different key; calling that a failure would
/// keep a superseded build permanently red and spend every `FIX_ROUND_CAP` round on it. GitLab
/// reports a single `head_pipeline` and has no such shape.
///
/// Anything unrecognised falls to `Unknown` rather than `Passing` for the same reason
/// `super::github`'s mapper is careful: Server has a literal `UNKNOWN` state, and reporting a green
/// build nobody ran is the worse of the two errors.
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

pub(super) async fn create_bitbucket(
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

pub(super) async fn fetch_bitbucket(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetails, String> {
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
            let pr: BitbucketCloudPullRequestState = read_json(response, "Bitbucket").await?;
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

pub(super) async fn ci_bitbucket(
    target: &PullRequestTarget<'_>,
    head_sha: Option<&str>,
) -> Result<CiState, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
