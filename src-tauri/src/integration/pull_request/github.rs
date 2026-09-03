//! GitHub, and the Gitea/Forgejo API modelled on it.
//!
//! One file rather than three because they share a response shape: a merged pull request is
//! `state: "closed"` with a separate `merged` flag on all of them, so `GitHubStyleState` and
//! `github_style_details` serve every arm here. What differs is the auth header and the base path.

use serde::Deserialize;

use super::{
    BranchPullRequest, CheckStatus, CiState, CreatedPullRequest, ListedPullRequest,
    PullRequestCheck, PullRequestDetails, PullRequestState, PullRequestSummary, PullRequestTarget,
    instance_base, owner_repo, read_json, summarise_checks,
};
use crate::integration::{build_http_client, normalize_instance_url};

#[derive(Deserialize)]
struct GitHubStylePullRequest {
    number: i64,
    html_url: String,
}

/// One entry of the pull request *list* endpoint, which is a different shape from the single-pull
/// request one: there is no `merged` flag and no `mergeable`, only a `merged_at` timestamp.
#[derive(Deserialize)]
struct GitHubStyleListEntry {
    number: i64,
    html_url: String,
    #[serde(default)]
    title: String,
    state: String,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    head: Option<GitHubHeadRef>,
    #[serde(default)]
    base: Option<GitHubBranchRef>,
    #[serde(default)]
    created_at: Option<String>,
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

/// One pull request's own numbers. Absent from the list endpoint, which is why this costs a
/// request of its own.
#[derive(Deserialize)]
struct GitHubPullRequestSummary {
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    base: Option<GitHubBranchRef>,
    #[serde(default)]
    head: Option<GitHubBranchRef>,
    #[serde(default)]
    commits: Option<i64>,
    #[serde(default)]
    changed_files: Option<i64>,
    #[serde(default)]
    additions: Option<i64>,
    #[serde(default)]
    deletions: Option<i64>,
    #[serde(default)]
    mergeable: Option<bool>,
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

/// The list endpoint carries `merged_at` where the single-pull-request one carries `merged`, so
/// the same "a merged pull request reads as closed" trap needs answering from a different field.
fn list_entry_to_branch_pull_request(entry: GitHubStyleListEntry) -> BranchPullRequest {
    let state = if entry.merged_at.is_some() {
        PullRequestState::Merged
    } else if entry.state == "closed" {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    };
    BranchPullRequest {
        number: entry.number,
        url: entry.html_url,
        title: entry.title,
        details: PullRequestDetails {
            state,
            mergeable: None,
            head_sha: entry.head.map(|head| head.sha),
        },
    }
}

/// An open pull request wins over a closed or merged one whatever order the forge returned them in.
///
/// A branch that has been round this loop before has several, and the card is about what is
/// happening now — "merged three weeks ago" is not it. With no open one among them the first
/// listed is taken, which for GitHub is the newest because the query sorts descending, and for
/// Gitea is whatever it chose to list first.
fn pick_branch_pull_request(mut entries: Vec<GitHubStyleListEntry>) -> Option<BranchPullRequest> {
    if entries.is_empty() {
        return None;
    }
    let index = entries.iter().position(|entry| entry.state == "open").unwrap_or(0);
    Some(list_entry_to_branch_pull_request(entries.swap_remove(index)))
}

pub(super) async fn find_github(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    let (owner, repo) = owner_repo(target.config)?;
    // The `head` filter is `owner:branch`, where the owner is the *head* repository's — so this
    // finds same-repository branches only, which is what Maestro's worktrees ever create.
    let url = format!(
        "{}/repos/{}/{}/pulls?state=all&sort=created&direction=desc&per_page=20&head={}:{}",
        github_api_base(target),
        owner,
        repo,
        urlencoding::encode(owner),
        urlencoding::encode(branch)
    );

    let entries: Vec<GitHubStyleListEntry> = read_json(
        build_http_client()?
            .get(url)
            .header("Authorization", format!("Bearer {}", target.token))
            .header("User-Agent", "maestro/1.0")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        "GitHub",
    )
    .await?;

    Ok(pick_branch_pull_request(entries))
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

pub(super) async fn find_gitea(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    let (owner, repo) = owner_repo(target.config)?;
    // Gitea and Forgejo have no head filter on this endpoint, so one page is fetched and matched
    // here. A branch whose pull request has fallen off the first page is reported as having none,
    // which is the same answer a closed repository gives and is not worth paging the whole history
    // on every poll to improve.
    let url = format!(
        "{}/api/v1/repos/{}/{}/pulls?state=all&limit=50",
        instance_base(target),
        urlencoding::encode(owner),
        urlencoding::encode(repo)
    );

    let entries: Vec<GitHubStyleListEntry> = read_json(
        build_http_client()?
            .get(url)
            .header("Authorization", format!("token {}", target.token))
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        "Gitea",
    )
    .await?;

    let matching: Vec<GitHubStyleListEntry> = entries
        .into_iter()
        .filter(|entry| {
            entry.head.as_ref().and_then(|head| head.head_ref.as_deref()) == Some(branch)
        })
        .collect();

    Ok(pick_branch_pull_request(matching))
}

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
    Ok(CreatedPullRequest { number: created.number, url: created.html_url })
}

pub(super) async fn fetch_github(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetails, String> {
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

pub(super) async fn ci_github(
    target: &PullRequestTarget<'_>,
    head_sha: Option<&str>,
) -> Result<CiState, String> {
    Ok(summarise_checks(&checks_github(target, head_sha).await?))
}

pub(super) async fn checks_github(
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

/// Commit statuses have four states and no separate "has it finished" flag, unlike check runs.
fn to_status_check(status: &GitHubCommitStatus) -> PullRequestCheck {
    let mapped = match status.state.as_str() {
        "success" => CheckStatus::Passed,
        "failure" | "error" => CheckStatus::Failed,
        _ => CheckStatus::Running,
    };
    PullRequestCheck { name: status.context.clone(), status: mapped }
}

pub(super) async fn summary_github(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestSummary, String> {
    let (owner, repo) = owner_repo(target.config)?;
    // Gitea and Forgejo serve a GitHub-shaped body from a different base, and answer a subset of
    // these fields; the `Option`s absorb whatever they leave out.
    let url = if target.config.provider == "github" {
        format!("{}/repos/{}/{}/pulls/{}", github_api_base(target), owner, repo, number)
    } else {
        format!(
            "{}/api/v1/repos/{}/{}/pulls/{}",
            instance_base(target),
            urlencoding::encode(owner),
            urlencoding::encode(repo),
            number
        )
    };
    let auth = if target.config.provider == "github" {
        format!("Bearer {}", target.token)
    } else {
        format!("token {}", target.token)
    };

    let pr: GitHubPullRequestSummary = read_json(
        build_http_client()?
            .get(url)
            .header("Authorization", auth)
            .header("User-Agent", "maestro/1.0")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?,
        "GitHub",
    )
    .await?;

    Ok(PullRequestSummary {
        created_at: pr.created_at,
        base_ref: pr.base.map(|base| base.name),
        head_ref: pr.head.map(|head| head.name),
        commits: pr.commits,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        mergeable: pr.mergeable,
    })
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
    Ok(CreatedPullRequest { number: created.number, url: created.html_url })
}

pub(super) async fn fetch_gitea(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetails, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn details(body: &str) -> PullRequestDetails {
        github_style_details(serde_json::from_str(body).expect("body should parse"))
    }

    fn listed(body: &str) -> Vec<ListedPullRequest> {
        let entries: Vec<GitHubStyleListEntry> =
            serde_json::from_str(body).expect("body should parse");
        entries.into_iter().filter_map(list_entry_to_listed).collect()
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

    fn entries(body: &str) -> Vec<GitHubStyleListEntry> {
        serde_json::from_str(body).expect("list body should parse")
    }

    /// The list endpoint has no `merged` flag, only `merged_at` — reading `state` alone would
    /// report every merged pull request as closed, which is the state the card paints red.
    #[test]
    fn a_merged_entry_is_recognised_from_its_timestamp() {
        let found = pick_branch_pull_request(entries(
            r#"[{"number":9,"html_url":"u","title":"t","state":"closed",
                 "merged_at":"2026-08-01T00:00:00Z"}]"#,
        ))
        .expect("one entry should be picked");
        assert_eq!(found.details.state, PullRequestState::Merged);

        let found = pick_branch_pull_request(entries(
            r#"[{"number":9,"html_url":"u","title":"t","state":"closed","merged_at":null}]"#,
        ))
        .expect("one entry should be picked");
        assert_eq!(found.details.state, PullRequestState::Closed);
    }

    /// A branch reused after an earlier attempt has several pull requests, and the open one is the
    /// only one the session is about. Taking the forge's first would show a merged pull request
    /// beside a branch that is being worked on right now.
    #[test]
    fn an_open_pull_request_wins_over_an_older_closed_one() {
        let found = pick_branch_pull_request(entries(
            r#"[{"number":9,"html_url":"old","title":"t","state":"closed"},
                {"number":12,"html_url":"live","title":"t","state":"open",
                 "head":{"sha":"abc","ref":"feature"}}]"#,
        ))
        .expect("the open entry should be picked");
        assert_eq!(found.number, 12);
        assert_eq!(found.url, "live");
        assert_eq!(found.details.head_sha.as_deref(), Some("abc"), "CI needs the head sha");

        // With none open the first listed stands in, rather than nothing at all.
        let found = pick_branch_pull_request(entries(
            r#"[{"number":9,"html_url":"newest","title":"t","state":"closed"},
                {"number":4,"html_url":"older","title":"t","state":"closed"}]"#,
        ))
        .expect("a closed entry should still be picked");
        assert_eq!(found.number, 9);

        assert!(pick_branch_pull_request(entries("[]")).is_none());
    }

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

    /// Every one of these is absent from the list endpoint, which is the whole reason the summary
    /// costs a second request. Gitea answers a subset, so each field has to survive being missing.
    #[test]
    fn a_summary_survives_the_fields_gitea_leaves_out() {
        let full: GitHubPullRequestSummary = serde_json::from_str(
            r#"{"created_at":"2026-09-01T10:00:00Z","base":{"ref":"main"},
                "head":{"ref":"feature"},"commits":2,"changed_files":22,
                "additions":1487,"deletions":18,"mergeable":true}"#,
        )
        .expect("body should parse");
        assert_eq!(full.base.map(|b| b.name).as_deref(), Some("main"));
        assert_eq!(full.commits, Some(2));
        assert_eq!(full.additions, Some(1487));
        assert_eq!(full.mergeable, Some(true));

        let bare: GitHubPullRequestSummary =
            serde_json::from_str(r#"{"number":1}"#).expect("a bare body should parse");
        assert_eq!(bare.changed_files, None);
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
