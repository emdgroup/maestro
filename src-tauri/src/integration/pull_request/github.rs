//! GitHub, and the Gitea/Forgejo API modelled on it.
//!
//! One file rather than three because they share a response shape: a merged pull request is
//! `state: "closed"` with a separate `merged` flag on all of them, so `GitHubStyleDetail` and
//! `github_style_details` serve every arm here. What differs is the auth header and the base path.

use serde::Deserialize;

use super::{
    CheckStatus, CiState, CreatedPullRequest, ListedPullRequest, PullRequestCheck,
    BranchPullRequest, FoundPullRequest, PullRequestChecks, PullRequestDetail, PullRequestState,
    PullRequestTarget, instance_base, owner_repo, read_json, summarise_checks,
};
use crate::integration::{build_http_client, normalize_instance_url};

#[derive(Deserialize)]
struct GitHubStylePullRequest {
    number: i64,
    html_url: String,
    /// Read from the create response so a freshly opened pull request arrives with the sha its CI
    /// is keyed on. Optional because Gitea has moved this field between versions.
    #[serde(default)]
    head: Option<GitHubHeadRef>,
}

/// One entry of the pull request *list* endpoint, which is a different shape from the single-pull
/// request one.
///
/// `state` is read only by [`pick_branch_pull_request`], which asks for every state and has to
/// prefer the open one. [`list_open_pull_requests`] asks for open pull requests only, so there it is
/// always `"open"` and carries nothing. There is deliberately no `merged_at` here: distinguishing a
/// merged pull request from a closed one is `fetch_github`'s job, which reads the single-pull-request
/// endpoint's `merged` flag rather than guessing from a timestamp this endpoint may omit.
#[derive(Deserialize)]
struct GitHubStyleListEntry {
    number: i64,
    html_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    head: Option<GitHubHeadRef>,
    #[serde(default)]
    base: Option<GitHubBranchRef>,
    #[serde(default)]
    created_at: Option<String>,
}

/// The single-pull-request endpoint's body, read whole.
///
/// State and the diff numbers used to be two structs read from two calls to this same URL. They are
/// one because the URL is one: `/repos/{o}/{r}/pulls/{n}` answers all of it, and asking twice paid
/// a request per poll to parse the other half of a body we already had.
///
/// Gitea and Forgejo answer a subset, which is what every `Option` here absorbs.
#[derive(Deserialize)]
struct GitHubStyleDetail {
    state: String,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    head: Option<GitHubHeadRef>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    base: Option<GitHubBranchRef>,
    #[serde(default)]
    commits: Option<i64>,
    #[serde(default)]
    changed_files: Option<i64>,
    #[serde(default)]
    additions: Option<i64>,
    #[serde(default)]
    deletions: Option<i64>,
}

#[derive(Deserialize)]
struct GitHubHeadRef {
    sha: String,
    /// Branch name, present on the list endpoint. Gitea has no `head` query filter, so this is
    /// what the client-side match below compares against.
    #[serde(rename = "ref", default)]
    head_ref: Option<String>,
}

#[derive(Deserialize)]
struct GitHubCheckRuns {
    check_runs: Vec<GitHubCheckRun>,
}

/// The *other* half of what GitHub's merge box shows.
///
/// Check runs and commit statuses are two unrelated APIs — Actions posts the former, third-party
/// apps like a CLA bot post the latter — and the pull request page merges them. Reading only
/// check-runs silently under-reported: a pull request GitHub called "2 in progress, 1 successful"
/// arrived here as two checks, with the third missing rather than wrong.
#[derive(Deserialize)]
struct GitHubCombinedStatus {
    #[serde(default)]
    statuses: Vec<GitHubCommitStatus>,
}

#[derive(Deserialize)]
struct GitHubCommitStatus {
    /// The status's name; GitHub calls it the context, e.g. `license/cla`.
    context: String,
    state: String,
}

#[derive(Deserialize)]
struct GitHubBranchRef {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Deserialize)]
struct GitHubCheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
}

/// GitHub and Gitea both report a merged PR as `closed` with a separate `merged` flag, so the
/// flag has to be consulted first or every merge would read as a rejection.
fn github_style_details(pr: GitHubStyleDetail) -> PullRequestDetail {
    let state = if pr.merged {
        PullRequestState::Merged
    } else if pr.state == "closed" {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    };
    // One `head` object carries both, so the branch name costs nothing beyond reading it.
    let (head_sha, head_ref) = match pr.head {
        Some(head) => (Some(head.sha), head.head_ref),
        None => (None, None),
    };
    PullRequestDetail {
        state,
        mergeable: pr.mergeable,
        head_sha,
        title: pr.title,
        created_at: pr.created_at,
        base_ref: pr.base.map(|base| base.name),
        head_ref,
        commits: pr.commits,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
    }
}

/// GitHub Enterprise serves the same API under `/api/v3` on the instance itself; github.com
/// serves it from a separate hostname.
fn github_api_base(target: &PullRequestTarget<'_>) -> String {
    match target.instance_url {
        Some(url) if target.config.host != "github.com" => {
            format!("{}/api/v3", normalize_instance_url(url))
        }
        _ => "https://api.github.com".to_string(),
    }
}

/// A check run is only a failure once it has a conclusion — anything still going is `Running`, and
/// `summarise_checks` lets that outrank a failure so a half-finished matrix does not start a coder
/// on a build that might yet turn green. `skipped` and `neutral` are conclusions, not failures.
fn to_check(run: &GitHubCheckRun) -> PullRequestCheck {
    let status = if run.status != "completed" {
        CheckStatus::Running
    } else if matches!(
        run.conclusion.as_deref(),
        Some("failure" | "timed_out" | "action_required")
    ) {
        CheckStatus::Failed
    } else {
        CheckStatus::Passed
    };
    PullRequestCheck { name: run.name.clone(), status }
}

/// `None` for an entry the forge listed without naming its head branch.
///
/// That is the field the Worktrees view matches a worktree on, so an entry missing it cannot be
/// linked to anything and cannot be checked out — a row for it would offer an action that could not
/// run. Gitea omits it on a pull request whose head repository has been deleted.
fn list_entry_to_listed(entry: GitHubStyleListEntry) -> Option<ListedPullRequest> {
    let head = entry.head?;
    Some(ListedPullRequest {
        number: entry.number,
        url: entry.html_url,
        title: entry.title,
        head_branch: head.head_ref?,
        base_branch: entry.base.map(|base| base.name),
        created_at: entry.created_at,
        head_sha: Some(head.sha),
    })
}

/// Every open pull request, for GitHub and for the Gitea/Forgejo API modelled on it.
///
/// One function for all three because only the base path and the auth header differ, exactly as in
/// [`summary_github`]. Sorted by most recently updated so that if a repository has more open pull
/// requests than one page holds, the ones that fall off are the ones nobody has touched.
pub(super) async fn list_github_family(
    target: &PullRequestTarget<'_>,
) -> Result<Vec<ListedPullRequest>, String> {
    let (owner, repo) = owner_repo(target.config)?;
    let (url, auth) = if target.config.provider == "github" {
        (
            format!(
                "{}/repos/{}/{}/pulls?state=open&sort=updated&direction=desc&per_page=100",
                github_api_base(target),
                owner,
                repo
            ),
            format!("Bearer {}", target.token),
        )
    } else {
        (
            format!(
                "{}/api/v1/repos/{}/{}/pulls?state=open&sort=recentupdate&limit=50",
                instance_base(target),
                urlencoding::encode(owner),
                urlencoding::encode(repo)
            ),
            format!("token {}", target.token),
        )
    };

    let entries: Vec<GitHubStyleListEntry> = read_json(
        build_http_client()?
            .get(url)
            .header("Authorization", auth)
            .header("User-Agent", "maestro/1.0")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        "GitHub",
    )
    .await?;

    Ok(entries.into_iter().filter_map(list_entry_to_listed).collect())
}

/// An open pull request wins over a closed or merged one whatever order the forge returned them in.
///
/// A branch that has been round this loop before has several, and the card is about what is
/// happening now — "merged three weeks ago" is not it. With no open one among them the first listed
/// is taken, which for GitHub is the newest because the query sorts descending, and for Gitea is
/// whatever it chose to list first.
fn pick_branch_pull_request(mut entries: Vec<GitHubStyleListEntry>) -> Option<FoundPullRequest> {
    if entries.is_empty() {
        return None;
    }
    let index = entries.iter().position(|entry| entry.state == "open").unwrap_or(0);
    let entry = entries.swap_remove(index);
    Some(FoundPullRequest { number: entry.number, url: entry.html_url })
}

/// The pull request on one branch, for GitHub and for the Gitea/Forgejo API modelled on it.
///
/// GitHub filters server-side; Gitea and Forgejo have no head filter on this endpoint, so one page
/// is fetched and matched here. A Gitea branch whose pull request has fallen off that page is
/// reported as having none, which is not worth paging the whole history on every poll to improve.
pub(super) async fn find_github_family(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<FoundPullRequest>, String> {
    let (owner, repo) = owner_repo(target.config)?;
    let is_github = target.config.provider == "github";
    let (url, auth) = if is_github {
        (
            // The `head` filter is `owner:branch`, where the owner is the *head* repository's — so
            // this finds same-repository branches only, which is what Maestro's worktrees create.
            format!(
                "{}/repos/{}/{}/pulls?state=all&sort=created&direction=desc&per_page=20&head={}:{}",
                github_api_base(target),
                owner,
                repo,
                urlencoding::encode(owner),
                urlencoding::encode(branch)
            ),
            format!("Bearer {}", target.token),
        )
    } else {
        (
            format!(
                "{}/api/v1/repos/{}/{}/pulls?state=all&limit={}",
                instance_base(target),
                urlencoding::encode(owner),
                urlencoding::encode(repo),
                GITEA_BRANCH_SCAN_LIMIT
            ),
            format!("token {}", target.token),
        )
    };

    let entries: Vec<GitHubStyleListEntry> = read_json(
        build_http_client()?
            .get(url)
            .header("Authorization", auth)
            .header("User-Agent", "maestro/1.0")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        if is_github { "GitHub" } else { "Gitea" },
    )
    .await?;

    let matching: Vec<GitHubStyleListEntry> = if is_github {
        entries
    } else {
        entries
            .into_iter()
            .filter(|entry| {
                entry.head.as_ref().and_then(|head| head.head_ref.as_deref()) == Some(branch)
            })
            .collect()
    };

    Ok(pick_branch_pull_request(matching))
}

/// How far back Gitea's unfiltered list is scanned for a branch. Its instances clamp to
/// `MAX_RESPONSE_ITEMS`, 50 by default, so asking for more is asking for nothing.
const GITEA_BRANCH_SCAN_LIMIT: usize = 50;

pub(super) async fn create_github(
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
    Ok(CreatedPullRequest {
        number: created.number,
        url: created.html_url,
        head_sha: created.head.map(|head| head.sha),
    })
}

pub(super) async fn fetch_github(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetail, String> {
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
    let pr: GitHubStyleDetail = read_json(response, "GitHub").await?;
    Ok(github_style_details(pr))
}

pub(super) async fn ci_github(
    target: &PullRequestTarget<'_>,
    number: i64,
    head_sha: Option<&str>,
) -> Result<CiState, String> {
    Ok(summarise_checks(&checks_github(target, number, head_sha).await?))
}

/// One pull request's checks, from whichever API can answer in fewest requests.
///
/// GraphQL's `statusCheckRollup` unions check runs with commit statuses, so it answers in one
/// request what [`checks_github_rest`] needs two for — and it is the field GitHub's own merge box
/// reads, so the two APIs cannot disagree about a check.
///
/// Only attempted against github.com. A GitHub Enterprise old enough to lack the field would fail
/// on every poll and pay a wasted request each time to rediscover it, and REST is what it would
/// fall back to anyway. The fallback still exists for github.com because a token can be scoped out
/// of GraphQL while REST keeps answering.
pub(super) async fn checks_github(
    target: &PullRequestTarget<'_>,
    number: i64,
    head_sha: Option<&str>,
) -> Result<Vec<PullRequestCheck>, String> {
    if target.config.host == "github.com" {
        match checks_one_github(target, number).await {
            Ok(checks) => return Ok(checks),
            Err(e) => log::debug!("[github] GraphQL checks unavailable, using REST: {}", e),
        }
    }
    checks_github_rest(target, head_sha).await
}

pub(super) async fn checks_github_rest(
    target: &PullRequestTarget<'_>,
    head_sha: Option<&str>,
) -> Result<Vec<PullRequestCheck>, String> {
    let Some(sha) = head_sha else {
        return Ok(Vec::new());
    };
    let (owner, repo) = owner_repo(target.config)?;
    let client = build_http_client()?;
    let api = github_api_base(target);
    let auth = format!("Bearer {}", target.token);

    // Two unrelated endpoints that answer about the same commit, so they are asked at once. Run
    // one after the other this used to cost two round trips on every ten-second poll.
    let (runs_response, status_response) = tokio::join!(
        client
            .get(format!("{}/repos/{}/{}/commits/{}/check-runs", api, owner, repo, sha))
            .header("Authorization", &auth)
            .header("User-Agent", "maestro/1.0")
            .send(),
        client
            .get(format!("{}/repos/{}/{}/commits/{}/status", api, owner, repo, sha))
            .header("Authorization", &auth)
            .header("User-Agent", "maestro/1.0")
            .send(),
    );

    let runs: GitHubCheckRuns =
        read_json(runs_response.map_err(|e| format!("Network error: {}", e))?, "GitHub").await?;
    let mut checks: Vec<PullRequestCheck> = runs.check_runs.iter().map(to_check).collect();

    // A failure to read statuses must not lose the check runs we already have — an under-reported
    // list is better than no card, and the alternative would take the whole rollup down whenever a
    // repository has the statuses API disabled.
    match status_response {
        Ok(response) => match read_json::<GitHubCombinedStatus>(response, "GitHub").await {
            Ok(combined) => checks.extend(combined.statuses.iter().map(to_status_check)),
            Err(e) => log::debug!("[github] commit statuses for {} unreadable: {}", sha, e),
        },
        Err(e) => log::debug!("[github] commit statuses for {} unreachable: {}", sha, e),
    }

    Ok(checks)
}

/// How many open pull requests one batch query covers.
///
/// GitHub caps a connection at 100 nodes, and a project with more open pull requests than that has
/// a Worktrees view nobody is reading card by card. Not paginated deliberately: the point of this
/// query is to be one request, and a second page would reintroduce the per-pull-request cost the
/// whole thing exists to remove.
const BATCH_PULL_REQUEST_LIMIT: usize = 100;

/// GraphQL lives beside the REST API, not under its `/api/v3` prefix.
fn github_graphql_url(target: &PullRequestTarget<'_>) -> String {
    match target.instance_url {
        Some(url) if target.config.host != "github.com" => {
            format!("{}/api/graphql", normalize_instance_url(url))
        }
        _ => "https://api.github.com/graphql".to_string(),
    }
}

#[derive(Deserialize)]
struct GraphQlResponse {
    data: Option<GraphQlData>,
    /// GraphQL answers a refused query with 200 and an `errors` array, so a successful HTTP status
    /// says nothing on its own.
    #[serde(default)]
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Deserialize)]
struct GraphQlError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct GraphQlData {
    repository: Option<GraphQlRepository>,
}

/// Either shape of check query answers into this: the batch one fills `pull_requests`, the
/// single-pull-request one fills `pull_request`. Both hang the same node off `repository`, so one
/// struct and one mapper serve them and the two cannot drift in how they read a rollup.
#[derive(Deserialize)]
struct GraphQlRepository {
    #[serde(default, rename = "pullRequests")]
    pull_requests: Option<GraphQlPullRequests>,
    #[serde(default, rename = "pullRequest")]
    pull_request: Option<GraphQlPullRequest>,
}

#[derive(Deserialize)]
struct GraphQlPullRequests {
    nodes: Vec<Option<GraphQlPullRequest>>,
}

#[derive(Deserialize)]
struct GraphQlPullRequest {
    number: i64,
    commits: GraphQlCommits,
}

#[derive(Deserialize)]
struct GraphQlCommits {
    nodes: Vec<Option<GraphQlCommitNode>>,
}

#[derive(Deserialize)]
struct GraphQlCommitNode {
    commit: GraphQlCommit,
}

#[derive(Deserialize)]
struct GraphQlCommit {
    oid: String,
    #[serde(rename = "statusCheckRollup")]
    rollup: Option<GraphQlRollup>,
}

#[derive(Deserialize)]
struct GraphQlRollup {
    contexts: GraphQlContexts,
}

#[derive(Deserialize)]
struct GraphQlContexts {
    nodes: Vec<Option<GraphQlContext>>,
}

/// One entry of `statusCheckRollup.contexts`, which is a union of the two things GitHub's merge box
/// adds together — the same pair `checks_github` reads from two REST endpoints.
#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum GraphQlContext {
    CheckRun {
        #[serde(default)]
        name: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        conclusion: Option<String>,
    },
    StatusContext {
        #[serde(default)]
        context: String,
        #[serde(default)]
        state: String,
    },
    /// A union GitHub extends later must not fail the whole query.
    #[serde(other)]
    Unknown,
}

/// GraphQL spells the same enums in upper case, so the mapping cannot be shared with `to_check` and
/// `to_status_check` — but the rules must not drift from them. `Running` for anything unfinished,
/// and only a real failure conclusion counts as `Failed`.
fn graphql_context_to_check(context: GraphQlContext) -> Option<PullRequestCheck> {
    match context {
        GraphQlContext::CheckRun { name, status, conclusion } => {
            let mapped = if status != "COMPLETED" {
                CheckStatus::Running
            } else if matches!(
                conclusion.as_deref(),
                Some("FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED")
            ) {
                CheckStatus::Failed
            } else {
                CheckStatus::Passed
            };
            Some(PullRequestCheck { name, status: mapped })
        }
        GraphQlContext::StatusContext { context, state } => {
            let mapped = match state.as_str() {
                "SUCCESS" => CheckStatus::Passed,
                "FAILURE" | "ERROR" => CheckStatus::Failed,
                _ => CheckStatus::Running,
            };
            Some(PullRequestCheck { name: context, status: mapped })
        }
        GraphQlContext::Unknown => None,
    }
}

/// The union behind GitHub's merge box: check runs and commit statuses in one list.
///
/// Written once because three queries select it, and a field asked for by one and not another would
/// make the Worktrees view and the session card disagree about the same pull request.
const ROLLUP_CONTEXTS: &str = r#"
    statusCheckRollup {
      contexts(first: 100) {
        nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        }
      }
    }"#;

/// `commits(last: 1)` is how GraphQL names the head commit — there is no `headCommit` field on a
/// pull request, and `headRefOid` alone would not carry the rollup hanging off the commit.
fn head_commit_rollup() -> String {
    ["commits(last: 1) { nodes { commit { oid ", ROLLUP_CONTEXTS, " } } }"].concat()
}

/// What both *check* queries select, which is the head commit's rollup and the number to key it on.
fn check_rollup_selection() -> String {
    ["number ", &head_commit_rollup()].concat()
}

fn batch_checks_query() -> String {
    [
        "query($owner: String!, $repo: String!, $limit: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequests(states: OPEN, first: $limit,
                         orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {",
        &check_rollup_selection(),
        "} } } }",
    ]
    .concat()
}

fn single_checks_query() -> String {
    [
        "query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {",
        &check_rollup_selection(),
        "} } }",
    ]
    .concat()
}

/// Everything the session card shows about one branch's pull request, in one request.
///
/// The whole reason the session stopped needing three queries. GitHub prices a call on its
/// `first`/`last` arguments rather than on what returns, so for a *single* pull request the
/// `contexts(first: 100)` inside [`ROLLUP_CONTEXTS`] is ~102 nodes — one point of an hourly 5,000.
/// State, title, branches, the diff counts, `mergeable` and every named check therefore cost exactly
/// what asking for state alone would have.
///
/// `commitCount` is aliased because `commits` is already spoken for by the rollup above: the same
/// field cannot be selected twice with different arguments under one name.
const BRANCH_SCALARS: &str = r#"
    number
    url
    state
    title
    baseRefName
    headRefName
    createdAt
    additions
    deletions
    changedFiles
    mergeable
    commitCount: commits { totalCount }"#;

/// Two aliased connections, because "the pull request on this branch" prefers an open one and falls
/// back to the most recent — and GitHub cannot express that ordering in a single connection. Both
/// take `first: 1`, so the pair costs ~2 points rather than the second request the alternative
/// would be.
///
/// `rateLimit` rides along free and is logged, so the cost above is measured rather than derived.
fn branch_status_query() -> String {
    [
        "query($owner: String!, $repo: String!, $branch: String!) {
          rateLimit { cost remaining }
          repository(owner: $owner, name: $repo) {
            open: pullRequests(headRefName: $branch, states: OPEN, first: 1) {
              nodes {",
        BRANCH_SCALARS,
        &head_commit_rollup(),
        "} }
            latest: pullRequests(headRefName: $branch, first: 1,
                                 orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {",
        BRANCH_SCALARS,
        &head_commit_rollup(),
        "} } } }",
    ]
    .concat()
}

fn graphql_to_checks(response: GraphQlResponse) -> Result<Vec<PullRequestChecks>, String> {
    if let Some(errors) = response.errors.filter(|errors| !errors.is_empty()) {
        let joined =
            errors.iter().map(|error| error.message.as_str()).collect::<Vec<_>>().join("; ");
        return Err(format!("GitHub refused the check query: {}", joined));
    }

    let repository = response
        .data
        .and_then(|data| data.repository)
        .ok_or_else(|| "GitHub returned no repository for the check query".to_string())?;

    let nodes = match repository.pull_requests {
        Some(connection) => connection.nodes,
        // The single-pull-request query, or a number the repository does not have.
        None => vec![repository.pull_request],
    };

    Ok(nodes
        .into_iter()
        .flatten()
        .map(|pull_request| {
            let commit = pull_request
                .commits
                .nodes
                .into_iter()
                .flatten()
                .next()
                .map(|node| node.commit);
            let (head_sha, checks) = match commit {
                Some(commit) => {
                    let checks = commit
                        .rollup
                        .map(|rollup| {
                            rollup
                                .contexts
                                .nodes
                                .into_iter()
                                .flatten()
                                .filter_map(graphql_context_to_check)
                                .collect()
                        })
                        .unwrap_or_default();
                    (Some(commit.oid), checks)
                }
                None => (None, Vec::new()),
            };
            PullRequestChecks { number: pull_request.number, head_sha, checks }
        })
        .collect())
}

/// Every open pull request's checks in one GraphQL request.
///
/// `statusCheckRollup` is the field behind GitHub's own merge box, so it already unions check runs
/// with commit statuses — the two REST endpoints `checks_github` has to join by hand, per pull
/// request. That is what turns 2N requests into one.
pub(super) async fn checks_all_github(
    target: &PullRequestTarget<'_>,
) -> Result<Vec<PullRequestChecks>, String> {
    let (owner, repo) = owner_repo(target.config)?;

    let response = build_http_client()?
        .post(github_graphql_url(target))
        .header("Authorization", format!("Bearer {}", target.token))
        .header("User-Agent", "maestro/1.0")
        .json(&serde_json::json!({
            "query": batch_checks_query(),
            "variables": { "owner": owner, "repo": repo, "limit": BATCH_PULL_REQUEST_LIMIT },
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    graphql_to_checks(read_json(response, "GitHub").await?)
}

/// One pull request's checks in one GraphQL request, against the two REST calls it replaces.
///
/// An empty list for a number the repository does not have, matching what the REST path answers for
/// a head commit the forge has no checks for — a missing pull request is not an error the card can
/// act on, and treating it as one would blank a card over a number that had merged.
async fn checks_one_github(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<Vec<PullRequestCheck>, String> {
    let (owner, repo) = owner_repo(target.config)?;

    let response = build_http_client()?
        .post(github_graphql_url(target))
        .header("Authorization", format!("Bearer {}", target.token))
        .header("User-Agent", "maestro/1.0")
        .json(&serde_json::json!({
            "query": single_checks_query(),
            "variables": { "owner": owner, "repo": repo, "number": number },
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let answered = graphql_to_checks(read_json(response, "GitHub").await?)?;
    Ok(answered.into_iter().next().map(|entry| entry.checks).unwrap_or_default())
}

#[derive(Deserialize)]
struct GraphQlBranchResponse {
    data: Option<GraphQlBranchData>,
    #[serde(default)]
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Deserialize)]
struct GraphQlBranchData {
    repository: Option<GraphQlBranchRepository>,
    #[serde(default, rename = "rateLimit")]
    rate_limit: Option<GraphQlRateLimit>,
}

#[derive(Deserialize)]
struct GraphQlRateLimit {
    cost: i64,
    remaining: i64,
}

#[derive(Deserialize)]
struct GraphQlBranchRepository {
    open: GraphQlBranchConnection,
    latest: GraphQlBranchConnection,
}

#[derive(Deserialize)]
struct GraphQlBranchConnection {
    nodes: Vec<Option<GraphQlBranchNode>>,
}

#[derive(Deserialize)]
struct GraphQlBranchNode {
    number: i64,
    url: String,
    state: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "baseRefName")]
    base_ref_name: Option<String>,
    #[serde(default, rename = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default)]
    additions: Option<i64>,
    #[serde(default)]
    deletions: Option<i64>,
    #[serde(default, rename = "changedFiles")]
    changed_files: Option<i64>,
    /// `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while GitHub computes the merge commit.
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default, rename = "commitCount")]
    commit_count: Option<GraphQlTotalCount>,
    commits: GraphQlCommits,
}

#[derive(Deserialize)]
struct GraphQlTotalCount {
    #[serde(rename = "totalCount")]
    total_count: i64,
}

/// `UNKNOWN` maps to `None`, not to `false`. GitHub answers it while it computes the merge commit in
/// the background, so treating it as a conflict would report one on the first read after any push.
fn graphql_mergeable(value: Option<&str>) -> Option<bool> {
    match value {
        Some("MERGEABLE") => Some(true),
        Some("CONFLICTING") => Some(false),
        _ => None,
    }
}

fn branch_node_to_pull_request(node: GraphQlBranchNode) -> BranchPullRequest {
    let state = match node.state.as_str() {
        "MERGED" => PullRequestState::Merged,
        "CLOSED" => PullRequestState::Closed,
        _ => PullRequestState::Open,
    };

    let commit = node.commits.nodes.into_iter().flatten().next().map(|entry| entry.commit);
    let (head_sha, checks) = match commit {
        Some(commit) => {
            let checks = commit
                .rollup
                .map(|rollup| {
                    rollup
                        .contexts
                        .nodes
                        .into_iter()
                        .flatten()
                        .filter_map(graphql_context_to_check)
                        .collect()
                })
                .unwrap_or_default();
            (Some(commit.oid), checks)
        }
        None => (None, Vec::new()),
    };

    BranchPullRequest {
        number: node.number,
        url: node.url,
        detail: PullRequestDetail {
            state,
            mergeable: graphql_mergeable(node.mergeable.as_deref()),
            head_sha,
            title: node.title,
            created_at: node.created_at,
            base_ref: node.base_ref_name,
            head_ref: node.head_ref_name,
            commits: node.commit_count.map(|count| count.total_count),
            changed_files: node.changed_files,
            additions: node.additions,
            deletions: node.deletions,
        },
        // A landed pull request's checks cannot change, and the card does not draw them, so the
        // rollup is dropped rather than carried — matching what the composed path asks for.
        checks: if state == PullRequestState::Open { checks } else { Vec::new() },
    }
}

/// The whole session card for one branch, in one GraphQL request.
///
/// `Ok(None)` is the forge saying this branch has no pull request — a real answer the caller shows
/// as an empty card. Only an `Err` means "ask another way", which is what makes the REST fallback
/// in `fetch_branch_pull_request` fire on a refused query and not on an absent pull request.
pub(super) async fn branch_status_github(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    let (owner, repo) = owner_repo(target.config)?;

    let response = build_http_client()?
        .post(github_graphql_url(target))
        .header("Authorization", format!("Bearer {}", target.token))
        .header("User-Agent", "maestro/1.0")
        .json(&serde_json::json!({
            "query": branch_status_query(),
            "variables": { "owner": owner, "repo": repo, "branch": branch },
        }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    graphql_to_branch_pull_request(read_json(response, "GitHub").await?)
}

fn graphql_to_branch_pull_request(
    response: GraphQlBranchResponse,
) -> Result<Option<BranchPullRequest>, String> {
    if let Some(errors) = response.errors.filter(|errors| !errors.is_empty()) {
        let joined =
            errors.iter().map(|error| error.message.as_str()).collect::<Vec<_>>().join("; ");
        return Err(format!("GitHub refused the branch query: {}", joined));
    }

    let data = response
        .data
        .ok_or_else(|| "GitHub returned no data for the branch query".to_string())?;

    // The one place the cost of this query is a measurement rather than an inference. `trace` would
    // hide it; `info` would print it on every poll.
    if let Some(rate) = data.rate_limit {
        log::debug!(
            "[github] branch status query cost {} point(s), {} remaining this hour",
            rate.cost,
            rate.remaining
        );
    }

    let repository = data
        .repository
        .ok_or_else(|| "GitHub returned no repository for the branch query".to_string())?;

    // Open wins over merged or closed however recently the other was touched: the card is about
    // what is happening now, and a comment on last month's merge is not it.
    let node = repository
        .open
        .nodes
        .into_iter()
        .chain(repository.latest.nodes)
        .flatten()
        .next();

    Ok(node.map(branch_node_to_pull_request))
}

/// Commit statuses have four states and no separate "has it finished" flag, unlike check runs.
fn to_status_check(status: &GitHubCommitStatus) -> PullRequestCheck {
    let mapped = match status.state.as_str() {
        "success" => CheckStatus::Passed,
        "failure" | "error" => CheckStatus::Failed,
        _ => CheckStatus::Running,
    };
    PullRequestCheck { name: status.context.clone(), status: mapped }
}

pub(super) async fn create_gitea(
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
    Ok(CreatedPullRequest {
        number: created.number,
        url: created.html_url,
        head_sha: created.head.map(|head| head.sha),
    })
}

pub(super) async fn fetch_gitea(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetail, String> {
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
    let pr: GitHubStyleDetail = read_json(response, "Gitea").await?;
    Ok(github_style_details(pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(body: &str) -> PullRequestDetail {
        github_style_details(serde_json::from_str(body).expect("body should parse"))
    }

    fn listed(body: &str) -> Vec<ListedPullRequest> {
        let entries: Vec<GitHubStyleListEntry> =
            serde_json::from_str(body).expect("body should parse");
        entries.into_iter().filter_map(list_entry_to_listed).collect()
    }

    fn batch(body: &str) -> Result<Vec<PullRequestChecks>, String> {
        graphql_to_checks(serde_json::from_str(body).expect("body should parse"))
    }

    fn branch(body: &str) -> Result<Option<BranchPullRequest>, String> {
        graphql_to_branch_pull_request(serde_json::from_str(body).expect("body should parse"))
    }

    fn picked(body: &str) -> Option<FoundPullRequest> {
        let entries: Vec<GitHubStyleListEntry> =
            serde_json::from_str(body).expect("body should parse");
        pick_branch_pull_request(entries)
    }

    /// The lookup asks for `state=all`, so a branch reused after a merge answers with both. The
    /// card is about what is happening now, and GitHub sorts newest-first — so without preferring
    /// the open one, a branch whose second attempt is open would report the first as merged.
    #[test]
    fn a_reused_branch_reports_its_open_pull_request_not_its_merged_one() {
        let found = picked(
            r#"[{"number":164,"html_url":"https://github.com/o/r/pull/164","state":"closed"},
                {"number":161,"html_url":"https://github.com/o/r/pull/161","state":"open"}]"#,
        );
        assert_eq!(found.map(|found| found.number), Some(161));
    }

    /// Nothing open leaves the first listed, which GitHub sorted newest-first — what became of the
    /// last attempt, rather than an empty card claiming the branch never had one.
    #[test]
    fn a_branch_whose_pull_requests_have_all_landed_answers_with_the_newest() {
        let found = picked(
            r#"[{"number":164,"html_url":"https://github.com/o/r/pull/164","state":"closed"},
                {"number":161,"html_url":"https://github.com/o/r/pull/161","state":"closed"}]"#,
        );
        assert_eq!(found.map(|found| found.number), Some(164));
    }

    /// A branch with no pull request is `None`, not an error. An error would be a failing request
    /// every thirty seconds on every branch that never gets one.
    #[test]
    fn a_branch_with_no_pull_request_is_not_an_error() {
        assert!(picked("[]").is_none());
    }

    /// The whole session card out of one answer, which is the point of the query. If any of these
    /// stopped being read the card would silently lose a line and the fallback would never fire —
    /// the request succeeded, it just came back thinner.
    #[test]
    fn one_branch_answer_carries_the_state_the_counts_and_the_checks() {
        let found = branch(
            r#"{"data":{"rateLimit":{"cost":2,"remaining":4998},"repository":{
                 "open":{"nodes":[{"number":164,"url":"https://github.com/o/r/pull/164",
                   "state":"OPEN","title":"Notify when an agent finishes",
                   "baseRefName":"main","headRefName":"maestro/great-lynx-58",
                   "createdAt":"2026-09-01T10:00:00Z","additions":1487,"deletions":18,
                   "changedFiles":22,"mergeable":"MERGEABLE","commitCount":{"totalCount":2},
                   "commits":{"nodes":[{"commit":{"oid":"deadbeef","statusCheckRollup":{
                     "contexts":{"nodes":[
                       {"__typename":"CheckRun","name":"build","status":"IN_PROGRESS",
                        "conclusion":null},
                       {"__typename":"StatusContext","context":"cla/signed","state":"SUCCESS"}
                     ]}}}}]}}]},
                 "latest":{"nodes":[]}}}}"#,
        )
        .expect("a well-formed answer should parse")
        .expect("the branch has a pull request");

        assert_eq!(found.number, 164);
        assert_eq!(found.url, "https://github.com/o/r/pull/164");
        assert_eq!(found.detail.state, PullRequestState::Open);
        assert_eq!(found.detail.title.as_deref(), Some("Notify when an agent finishes"));
        assert_eq!(found.detail.head_ref.as_deref(), Some("maestro/great-lynx-58"));
        assert_eq!(found.detail.head_sha.as_deref(), Some("deadbeef"));
        assert_eq!(found.detail.additions, Some(1487));
        assert_eq!(found.detail.changed_files, Some(22));
        assert_eq!(found.detail.commits, Some(2), "aliased past the rollup's own `commits`");
        assert_eq!(found.detail.mergeable, Some(true));
        assert_eq!(
            found.checks.iter().map(|check| (check.name.as_str(), check.status)).collect::<Vec<_>>(),
            vec![("build", CheckStatus::Running), ("cla/signed", CheckStatus::Passed)]
        );
    }

    /// The two aliases exist because GitHub cannot express "open, else the most recent" in one
    /// connection. Reading only `open` would lose a merged pull request the user came back to see.
    #[test]
    fn a_branch_with_nothing_open_falls_through_to_its_latest() {
        let found = branch(
            r#"{"data":{"repository":{
                 "open":{"nodes":[]},
                 "latest":{"nodes":[{"number":161,"url":"https://github.com/o/r/pull/161",
                   "state":"MERGED","commits":{"nodes":[{"commit":{"oid":"c0ffee",
                     "statusCheckRollup":{"contexts":{"nodes":[
                       {"__typename":"CheckRun","name":"build","status":"COMPLETED",
                        "conclusion":"SUCCESS"}
                     ]}}}}]}}]}}}}"#,
        )
        .expect("a well-formed answer should parse")
        .expect("the branch has a merged pull request");

        assert_eq!(found.number, 161);
        assert_eq!(found.detail.state, PullRequestState::Merged);
        // A landed pull request's checks cannot change and the card does not draw them, so they are
        // dropped rather than carried — matching what the composed REST path asks for.
        assert!(found.checks.is_empty());
    }

    /// A branch nobody has opened anything from answers two empty connections, which is `None` —
    /// not an error, and not a card.
    #[test]
    fn a_branch_the_repository_has_no_pull_request_for_answers_none() {
        let found = branch(r#"{"data":{"repository":{"open":{"nodes":[]},"latest":{"nodes":[]}}}}"#)
            .expect("empty connections should parse");
        assert!(found.is_none());
    }

    /// GitHub answers `UNKNOWN` while it computes the merge commit in the background, which is
    /// every first read after a push. Reading that as a conflict would put a "resolve conflicts"
    /// warning on a pull request that merges cleanly.
    #[test]
    fn a_mergeable_state_github_has_not_computed_is_not_a_conflict() {
        assert_eq!(graphql_mergeable(Some("MERGEABLE")), Some(true));
        assert_eq!(graphql_mergeable(Some("CONFLICTING")), Some(false));
        assert_eq!(graphql_mergeable(Some("UNKNOWN")), None);
        assert_eq!(graphql_mergeable(None), None);
    }

    /// GraphQL answers a refused query with HTTP 200 and an `errors` array. Missing it here would
    /// read as "this branch has no pull request" and silently hide the card instead of falling back
    /// to the REST path.
    #[test]
    fn a_refused_branch_query_is_an_error_not_an_absent_pull_request() {
        let error = branch(r#"{"data":null,"errors":[{"message":"Resource not accessible"}]}"#)
            .expect_err("an errors array should not read as an empty answer");
        assert!(error.contains("Resource not accessible"), "the forge's own words: {}", error);
    }

    /// The branch query has to select the same rollup the check queries do, or the session card and
    /// the Worktrees view would disagree about the same pull request — and it has to keep asking
    /// for `rateLimit`, which is the only measurement of what this query actually costs.
    #[test]
    fn the_branch_query_selects_the_shared_rollup_and_its_own_cost() {
        let query = branch_status_query();
        assert!(query.contains("... on CheckRun"), "{}", query);
        assert!(query.contains("... on StatusContext"), "{}", query);
        assert!(query.contains("commits(last: 1)"), "{}", query);
        assert!(query.contains("rateLimit { cost remaining }"), "{}", query);
        // Both aliases, or "open, else the most recent" quietly becomes "whatever GitHub listed".
        assert!(query.contains("open: pullRequests"), "{}", query);
        assert!(query.contains("latest: pullRequests"), "{}", query);
        // `commits` is spoken for by the rollup, so the count has to be aliased or GitHub rejects
        // the whole query for selecting one field twice with different arguments.
        assert!(query.contains("commitCount: commits { totalCount }"), "{}", query);
    }

    /// One query has to answer what two REST endpoints did. `statusCheckRollup` unions check runs
    /// with commit statuses, and reading only the former under-reported exactly as the REST path
    /// did before it learned to join them.
    #[test]
    fn a_batch_answer_unions_check_runs_with_commit_statuses() {
        let checks = batch(
            r#"{"data":{"repository":{"pullRequests":{"nodes":[
                 {"number":310,"commits":{"nodes":[{"commit":{"oid":"deadbeef",
                   "statusCheckRollup":{"contexts":{"nodes":[
                     {"__typename":"CheckRun","name":"build","status":"COMPLETED",
                      "conclusion":"FAILURE"},
                     {"__typename":"CheckRun","name":"e2e","status":"IN_PROGRESS",
                      "conclusion":null},
                     {"__typename":"StatusContext","context":"cla/signed","state":"SUCCESS"}
                   ]}}}}]}}
               ]}}}}"#,
        )
        .expect("a well-formed answer should parse");

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].number, 310);
        assert_eq!(checks[0].head_sha.as_deref(), Some("deadbeef"), "CI is keyed on the head sha");
        assert_eq!(
            checks[0].checks.iter().map(|check| (check.name.as_str(), check.status)).collect::<Vec<_>>(),
            vec![
                ("build", CheckStatus::Failed),
                ("e2e", CheckStatus::Running),
                ("cla/signed", CheckStatus::Passed),
            ]
        );
    }

    /// The case behind the complaint that started this: a pull request opened seconds ago has no
    /// rollup at all. It must come back as a known pull request with no checks — not be dropped,
    /// which would leave the card with no way to tell "CI has not started" from "no such pull
    /// request", and not error, which would blank every other card in the view.
    #[test]
    fn a_pull_request_whose_ci_has_not_queued_yet_still_answers() {
        let checks = batch(
            r#"{"data":{"repository":{"pullRequests":{"nodes":[
                 {"number":311,"commits":{"nodes":[
                   {"commit":{"oid":"c0ffee","statusCheckRollup":null}}]}}
               ]}}}}"#,
        )
        .expect("a rollup-less pull request should parse");

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].head_sha.as_deref(), Some("c0ffee"));
        assert!(checks[0].checks.is_empty(), "no rollup is no checks, not a missing pull request");
    }

    /// The single-pull-request query hangs one object off `repository` where the batch hangs a
    /// connection, and both feed this mapper. If it stopped reading the singular field the session
    /// card would fall back to REST on every poll and never say why.
    #[test]
    fn one_pull_request_answers_through_the_same_mapper_as_the_batch() {
        let checks = batch(
            r#"{"data":{"repository":{"pullRequest":
                 {"number":312,"commits":{"nodes":[{"commit":{"oid":"facade",
                   "statusCheckRollup":{"contexts":{"nodes":[
                     {"__typename":"CheckRun","name":"test","status":"COMPLETED",
                      "conclusion":"SUCCESS"}
                   ]}}}}]}}
               }}}"#,
        )
        .expect("a single-pull-request answer should parse");

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].number, 312);
        assert_eq!(checks[0].head_sha.as_deref(), Some("facade"));
        assert_eq!(checks[0].checks[0].status, CheckStatus::Passed);
    }

    /// A number the repository does not have answers `pullRequest: null`, which must read as no
    /// checks rather than as an error — the caller turns an error into a REST retry, and retrying
    /// forever over a pull request that does not exist would poll for the life of the session.
    #[test]
    fn a_number_the_repository_does_not_have_is_not_an_error() {
        let checks =
            batch(r#"{"data":{"repository":{"pullRequest":null}}}"#).expect("null should parse");
        assert!(checks.is_empty());
    }

    /// Both queries have to select the same fields, because both are read by `graphql_to_checks`.
    /// Asking for a field in one and not the other is how the Worktrees view and the session card
    /// would start disagreeing about the same pull request.
    #[test]
    fn both_check_queries_select_the_same_rollup() {
        for query in [batch_checks_query(), single_checks_query()] {
            assert!(query.contains("statusCheckRollup"), "{}", query);
            assert!(query.contains("... on CheckRun"), "{}", query);
            assert!(query.contains("... on StatusContext"), "{}", query);
            assert!(query.contains("commits(last: 1)"), "{}", query);
        }
    }

    /// GraphQL answers a refused query with HTTP 200 and an `errors` array, so the transport's
    /// status says nothing. Missing this is what would silently paint every card "no checks
    /// reported" instead of falling back to the per-request path.
    #[test]
    fn a_refused_query_is_an_error_despite_the_200() {
        let error = batch(r#"{"data":null,"errors":[{"message":"Resource not accessible"}]}"#)
            .expect_err("an errors array should not read as an empty answer");
        assert!(error.contains("Resource not accessible"), "the forge's own words: {}", error);

        batch(r#"{"data":{"repository":null}}"#)
            .expect_err("a repository GitHub would not name is not an empty check list");
    }

    /// The contexts field is a union GitHub can extend. An unrecognised member is one check we
    /// cannot render, not a reason to lose the ones beside it.
    #[test]
    fn an_unknown_context_member_does_not_take_the_rest_with_it() {
        let checks = batch(
            r#"{"data":{"repository":{"pullRequests":{"nodes":[
                 {"number":312,"commits":{"nodes":[{"commit":{"oid":"abc",
                   "statusCheckRollup":{"contexts":{"nodes":[
                     {"__typename":"SomethingNew"},
                     {"__typename":"CheckRun","name":"vitest","status":"COMPLETED",
                      "conclusion":"SUCCESS"}
                   ]}}}}]}}
               ]}}}}"#,
        )
        .expect("an unknown member should parse");

        assert_eq!(checks[0].checks.len(), 1);
        assert_eq!(checks[0].checks[0].name, "vitest");
        assert_eq!(checks[0].checks[0].status, CheckStatus::Passed);
    }

    /// The list endpoint is the only request the Worktrees view makes for the whole project, so
    /// every field the panel and the card chips read has to survive this mapping.
    #[test]
    fn a_listed_pull_request_carries_both_branches_and_its_head() {
        let listed = listed(
            r#"[{"number":310,"html_url":"https://github.com/o/r/pull/310","title":"Ship it",
                 "state":"open","created_at":"2026-09-02T09:00:00Z",
                 "head":{"sha":"deadbeef","ref":"maestro/great-lynx-58"},
                 "base":{"ref":"main"}}]"#,
        );
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].number, 310);
        assert_eq!(listed[0].title, "Ship it");
        assert_eq!(listed[0].head_branch, "maestro/great-lynx-58");
        assert_eq!(listed[0].base_branch.as_deref(), Some("main"));
        assert_eq!(listed[0].head_sha.as_deref(), Some("deadbeef"));
        assert_eq!(listed[0].created_at.as_deref(), Some("2026-09-02T09:00:00Z"));
    }

    /// The head branch is what a worktree is matched on and what a new one would be checked out
    /// from, so an entry without one can neither be linked nor acted on. Gitea omits it when the
    /// head repository has been deleted.
    #[test]
    fn an_entry_with_no_head_branch_is_dropped() {
        assert!(listed(r#"[{"number":1,"html_url":"u","state":"open","head":{"sha":"abc"}}]"#)
            .is_empty());
        assert!(listed(r#"[{"number":1,"html_url":"u","state":"open"}]"#).is_empty());
    }

    /// Gitea and Forgejo answer a subset of GitHub's fields. The panel drops what is missing rather
    /// than failing to parse the entries that are there.
    #[test]
    fn a_forge_that_omits_the_base_still_lists() {
        let listed = listed(
            r#"[{"number":7,"html_url":"u","title":"T","state":"open",
                 "head":{"sha":"abc","ref":"feature"}}]"#,
        );
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].base_branch, None);
        assert_eq!(listed[0].created_at, None);
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

    // The two tests that stood here covered picking one branch's pull request out of a mixed list
    // — which merged/closed entry wins, and reading `merged_at` because this endpoint has no
    // `merged` flag. Both went with the branch search itself. The list is open-only now, so there
    // is nothing to pick between, and "merged or closed?" is asked by number through `fetch_github`
    // and covered by `a_merged_pull_request_is_not_a_closed_one` above.

    /// Check runs and commit statuses are separate GitHub APIs that its own merge box adds
    /// together. Reading only check-runs under-reported by however many statuses a repository has:
    /// a pull request GitHub called "2 in progress, 1 successful" arrived here as two checks, with
    /// the CLA bot's status missing rather than wrong.
    #[test]
    fn a_commit_status_is_a_check_too() {
        let status = |context: &str, state: &str| GitHubCommitStatus {
            context: context.into(),
            state: state.into(),
        };
        assert_eq!(to_status_check(&status("license/cla", "success")).status, CheckStatus::Passed);
        assert_eq!(to_status_check(&status("deploy", "failure")).status, CheckStatus::Failed);
        assert_eq!(to_status_check(&status("deploy", "error")).status, CheckStatus::Failed);
        assert_eq!(to_status_check(&status("deploy", "pending")).status, CheckStatus::Running);
        assert_eq!(to_status_check(&status("license/cla", "success")).name, "license/cla");
    }

    /// The combined-status body omits `statuses` entirely on a repository that has none, and that
    /// has to read as "no extra checks" rather than failing the whole rollup.
    #[test]
    fn a_repository_with_no_statuses_still_parses() {
        let combined: GitHubCombinedStatus =
            serde_json::from_str(r#"{"state":"success"}"#).expect("body should parse");
        assert!(combined.statuses.is_empty());
    }

    /// Every field below `head_sha` is absent from the list endpoint, and all of them arrive in the
    /// same body as the state — which is why this is one request and one struct rather than two of
    /// each. Gitea answers a subset, so each has to survive being missing.
    #[test]
    fn one_body_answers_the_state_and_the_numbers_together() {
        let full = details(
            r#"{"state":"open","merged":false,"title":"Ship it","mergeable":true,
                "created_at":"2026-09-01T10:00:00Z","base":{"ref":"main"},
                "head":{"sha":"deadbeef","ref":"feature"},"commits":2,"changed_files":22,
                "additions":1487,"deletions":18}"#,
        );
        assert_eq!(full.state, PullRequestState::Open);
        assert_eq!(full.title.as_deref(), Some("Ship it"));
        assert_eq!(full.base_ref.as_deref(), Some("main"));
        // Both come off the one `head` object, so neither costs a request the other did not.
        assert_eq!(full.head_ref.as_deref(), Some("feature"));
        assert_eq!(full.head_sha.as_deref(), Some("deadbeef"));
        assert_eq!(full.commits, Some(2));
        assert_eq!(full.additions, Some(1487));
        assert_eq!(full.mergeable, Some(true));

        let bare = details(r#"{"state":"open"}"#);
        assert_eq!(bare.changed_files, None);
        assert_eq!(bare.title, None, "a missing title must not become an empty one");
        assert_eq!(bare.mergeable, None, "a missing flag is not a conflict");
    }

    /// Check runs on their own, summarised. Production reads them alongside commit statuses and
    /// summarises the two together, so this exists only to test the check-run half in isolation —
    /// which is where the `status`/`conclusion` distinction below actually lives.
    fn summarise_check_runs(runs: &[GitHubCheckRun]) -> CiState {
        summarise_checks(&runs.iter().map(to_check).collect::<Vec<_>>())
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
