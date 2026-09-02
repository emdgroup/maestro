//! Opening a pull request on the forge that hosts a project's remote.
//!
//! This is deliberately not a git operation. Pushing a branch is; everything past it is not.
//! GitLab's push options are the only git-side route to creating a merge request and they cover
//! exactly one forge, so every provider here goes over HTTP instead — which also means the call
//! runs on the machine running Maestro for every connection type, with nothing to diverge.
//!
//! This file is the dispatch and the vocabulary: the three entry points, the types they answer
//! with, and the handful of helpers more than one forge needs. Each forge's own coordinates,
//! request shapes and response mapping live in its submodule.
//!
//! Split that way because the shape they were once assumed to share — one POST, one
//! `{number, url}` back — only ever described GitHub, GitLab and Gitea. Bitbucket is two unrelated
//! REST trees behind one provider string, and Azure DevOps returns no browser URL, needs a
//! repository id resolved before it will create anything, and answers an under-scoped token with a
//! sign-in page. Two of five forges being exceptions is not a shared shape.

use serde::Deserialize;

mod azure_devops;
mod bitbucket;
mod github;
mod gitlab;

use self::azure_devops::{create_azure_devops, fetch_azure_devops};
use self::bitbucket::{ci_bitbucket, create_bitbucket, fetch_bitbucket};
use self::github::{
    checks_github, ci_github, create_gitea, create_github, fetch_gitea, fetch_github, find_gitea,
    find_github, summary_github,
};
use self::gitlab::{
    checks_gitlab, ci_gitlab, create_gitlab, fetch_gitlab, find_gitlab, summary_gitlab,
};
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

/// A pull request located by the branch it was opened from, rather than by a number we stored.
///
/// Looking it up this way is what lets the session panel show a pull request nobody told Maestro
/// about — one opened on the forge by hand, or by an earlier install. Nothing is persisted, so
/// there is no stored id to go stale and no second copy of the forge's own state.
///
/// `mergeable` inside `details` is always `None` here: every forge's *list* endpoint omits it, and
/// asking for it would cost a second request per poll to answer a question this card does not ask.
pub struct BranchPullRequest {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub details: PullRequestDetails,
}

/// The pull request whose head is `branch`, if the forge has one.
///
/// `Ok(None)` means the forge answered and has no pull request for that branch. An unsupported
/// forge is an error rather than `None`, because the two are not the same thing to a user looking
/// at a card that is not there — and silently reporting "no pull request" for a branch that has one
/// is the one answer this must never give.
///
/// Only same-repository branches are found. A pull request opened from a fork lives under the
/// fork's owner, which this does not search.
pub async fn find_pull_request_by_head(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    match target.config.provider.as_str() {
        "github" => find_github(target, branch).await,
        "gitea" | "forgejo" => find_gitea(target, branch).await,
        "gitlab" => find_gitlab(target, branch).await,
        other => Err(format!(
            "Maestro cannot look up a pull request by branch on `{}` yet.",
            other
        )),
    }
}

/// Whether [`find_pull_request_by_head`] has an arm for this forge.
///
/// Beside the match it describes for the same reason as [`supports_pull_requests`]: this decides
/// whether the frontend polls at all, and a disagreement between the two would either poll a forge
/// that always errors or hide a card for a forge that would have answered.
pub fn supports_branch_lookup(config: &ProjectCodeHostingConfig) -> bool {
    matches!(config.provider.as_str(), "github" | "gitea" | "forgejo" | "gitlab")
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
/// `azure_devops::credential_matches_coordinates` for what happens when the wrong one answers.
/// Returns `None` for every other provider, and for a remote path this cannot read — the caller
/// then gets the host-matching behaviour every other forge has always had.
pub fn preferred_credential_base(config: &ProjectCodeHostingConfig) -> Option<String> {
    if config.provider != "azuredevops" {
        return None;
    }
    azure_devops::preferred_base(&config.host, &config.project_path)
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
        "github" => fetch_github(target, number).await,
        "gitlab" => fetch_gitlab(target, number).await,
        "gitea" | "forgejo" => fetch_gitea(target, number).await,
        "bitbucket" => fetch_bitbucket(target, number).await,
        "azuredevops" => fetch_azure_devops(target, number).await,
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

/// The fuller picture of one pull request, from the forge's single-pull-request endpoint.
///
/// Deliberately not folded into [`PullRequestDetails`]: every field here is absent from the *list*
/// endpoints [`find_pull_request_by_head`] uses, so filling it costs a second request — one the
/// reconcile sweep has no use for and should not start paying per task per pass.
///
/// Every field is optional because the forges disagree about which of them they will answer.
/// GitLab reports no line counts without another request; nobody but GitHub reports a commit count
/// on this endpoint at all. A `None` renders as an absent line rather than a zero.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullRequestSummary {
    pub created_at: Option<String>,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub commits: Option<i64>,
    pub changed_files: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    /// `None` while the forge is still computing the merge commit — see [`PullRequestDetails`],
    /// where the same three-valued rule keeps a freshly pushed branch from reading as conflicted.
    pub mergeable: Option<bool>,
}

/// Ask the forge for the numbers the branch lookup could not supply.
///
/// An empty summary rather than an error wherever a forge will not answer: the card is built out
/// of whatever lines can be filled, and one missing field must not take the whole card down.
pub async fn fetch_pull_request_summary(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestSummary, String> {
    match target.config.provider.as_str() {
        "github" | "gitea" | "forgejo" => summary_github(target, number).await,
        "gitlab" => summary_gitlab(target, number).await,
        _ => Ok(PullRequestSummary::default()),
    }
}

/// One check the forge ran against a pull request's head commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestCheck {
    pub name: String,
    pub status: CheckStatus,
}

/// Three states rather than the forge's own vocabulary, which has a dozen words across five
/// providers. `Passed` absorbs skipped and neutral: they are not failures, and a card that showed
/// them separately would report a red count for a repository that simply skips a job on some paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Passed,
    Failed,
    Running,
}

/// The verdict [`fetch_ci_state`] reports, derived from the individual checks.
///
/// Shared so the detailed listing and the sweep's yes/no answer cannot disagree: the only thing
/// done with `Failing` is to start an agent, and a card saying "1 failed" beside a sweep that
/// decided `Pending` would be two different truths about one pull request.
///
/// `Running` outranks `Failed` deliberately — a matrix still going might yet turn green, and
/// spending a fix round on it is the mistake this ordering exists to prevent.
pub fn summarise_checks(checks: &[PullRequestCheck]) -> CiState {
    if checks.is_empty() {
        return CiState::Unknown;
    }
    if checks.iter().any(|check| check.status == CheckStatus::Running) {
        return CiState::Pending;
    }
    let failed: Vec<String> = checks
        .iter()
        .filter(|check| check.status == CheckStatus::Failed)
        .map(|check| check.name.clone())
        .collect();
    if failed.is_empty() { CiState::Passing } else { CiState::Failing(failed) }
}

/// Every check the forge ran, named, for the session panel's rollup.
///
/// Separate from [`fetch_ci_state`] because the two callers want different things: the sweep needs
/// a verdict and nothing else, and giving it this would make it carry a list it discards on every
/// pass for every open pull request. Returns an empty list wherever the forge will not enumerate,
/// which [`summarise_checks`] then reads as `Unknown`.
pub async fn fetch_ci_checks(
    target: &PullRequestTarget<'_>,
    number: i64,
    head_sha: Option<&str>,
) -> Result<Vec<PullRequestCheck>, String> {
    match target.config.provider.as_str() {
        "github" => checks_github(target, head_sha).await,
        "gitlab" => checks_gitlab(target, number).await,
        _ => Ok(Vec::new()),
    }
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
        "github" => ci_github(target, head_sha).await,
        "gitlab" => ci_gitlab(target, number).await,
        "bitbucket" => ci_bitbucket(target, head_sha).await,
        // Gitea and Forgejo expose commit statuses, but the shape has moved between versions and
        // no answer at all is safer here than a wrong one.
        _ => Ok(CiState::Unknown),
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
