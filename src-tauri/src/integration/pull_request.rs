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

use self::azure_devops::{create_azure_devops, fetch_azure_devops, list_azure_devops};
use self::bitbucket::{ci_bitbucket, create_bitbucket, fetch_bitbucket, list_bitbucket};
use self::github::{
    checks_all_github, checks_github, checks_github_rest, ci_github, create_gitea, create_github,
    fetch_gitea, fetch_github, list_github_family,
};
use self::gitlab::{checks_gitlab, ci_gitlab, create_gitlab, fetch_gitlab, list_gitlab};
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
    /// The head commit the forge recorded, so the caller can put the new pull request in front of
    /// the user without waiting for a list endpoint to catch up with its own write. `None` wherever
    /// the create response does not carry it, which leaves the caller to fill it from the next
    /// list refresh.
    pub head_sha: Option<String>,
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

/// Everything one look at the forge's single-pull-request endpoint says.
///
/// One struct rather than the state/summary pair this used to be, because on every forge that
/// answers both they are *the same request* — `/repos/{o}/{r}/pulls/{n}` on GitHub and Gitea, the
/// merge request URL on GitLab. Asking twice to deserialize different halves of one body cost a
/// request per poll to learn nothing new.
///
/// `mergeable` is three-valued on purpose, and `None` means "no answer" rather than "mergeable".
/// GitHub computes the merge commit in the background and returns `null` on the first read after
/// any push; GitLab never answers at all. A conflict has to be positively reported before a task
/// is taken off the forge and handed to a person.
///
/// `head_sha` rides along because the caller needs it to ask about CI, and it arrives in the same
/// response. Fetching it separately was a second identical request per task per sweep.
///
/// Everything below `head_sha` is optional because the forges disagree about which of them they
/// answer: GitLab reports no line counts without another request, nobody but GitHub reports a
/// commit count here, and Bitbucket and Azure DevOps answer none of them. A `None` renders as an
/// absent line rather than a zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestDetail {
    pub state: PullRequestState,
    pub mergeable: Option<bool>,
    pub head_sha: Option<String>,
    /// Read on every poll rather than taken from the open list, so a rename on the forge reaches
    /// the card — and reaches it for a merged pull request, which has left that list for good.
    pub title: Option<String>,
    pub created_at: Option<String>,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub commits: Option<i64>,
    pub changed_files: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
}

impl PullRequestDetail {
    /// For the forges whose single-pull-request endpoint is read for state and nothing else.
    ///
    /// There is no `Default` for this: a pull request has no default state, and inventing one would
    /// let a forge that failed to answer read as open.
    pub fn from_state(
        state: PullRequestState,
        mergeable: Option<bool>,
        head_sha: Option<String>,
    ) -> Self {
        Self {
            state,
            mergeable,
            head_sha,
            title: None,
            created_at: None,
            base_ref: None,
            head_ref: None,
            commits: None,
            changed_files: None,
            additions: None,
            deletions: None,
        }
    }
}

// Searching the forge for one branch's pull request used to live here, under
// `find_pull_request_by_head`. Nothing asks that question any more: a session finds its pull
// request in [`list_open_pull_requests`] — the same list the Worktrees view already polls — which
// answers it for every branch in the project at once, where the search cost a request per session
// and then two more to fill the card it returned.

/// One entry of the project-wide open list.
///
/// `head_branch` is the field that makes this the answer to "which pull request is on this branch",
/// for a worktree card and for a session alike — both match on it rather than asking the forge.
///
/// No line counts, file count or mergeable flag: every forge's *list* endpoint omits them, and they
/// only change when the head commit does, so they are fetched separately and cached against
/// `head_sha` rather than re-read on every poll.
pub struct ListedPullRequest {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub head_branch: String,
    pub base_branch: Option<String>,
    pub created_at: Option<String>,
    pub head_sha: Option<String>,
}

/// Every pull request currently open on the project's forge.
///
/// One request answers "which pull request is on this branch" for the whole project — every
/// worktree card and every open session at once. That is the reason this exists: asked per branch
/// instead, it was a search per session plus two more requests to fill the card it returned.
///
/// Only open ones: asking for every state would page through the repository's whole history to find
/// the few that are live. A pull request that leaves this list has merged or closed, and the caller
/// that was watching it asks [`fetch_pull_request`] by number for which of the two.
///
/// Same-repository branches only — a fork's head branch is in another namespace, which no worktree
/// here is on.
pub async fn list_open_pull_requests(
    target: &PullRequestTarget<'_>,
) -> Result<Vec<ListedPullRequest>, String> {
    match target.config.provider.as_str() {
        "github" | "gitea" | "forgejo" => list_github_family(target).await,
        "gitlab" => list_gitlab(target).await,
        "bitbucket" => list_bitbucket(target).await,
        "azuredevops" => list_azure_devops(target).await,
        other => Err(unsupported(other, "list pull requests")),
    }
}

/// The message for a provider [`capabilities`] does not claim, written once so the six dispatchers
/// cannot describe the same gap in six ways.
fn unsupported(provider: &str, action: &str) -> String {
    format!("Maestro cannot {} on `{}` yet.", action, provider)
}

/// What Maestro has implemented for one forge, in one place.
///
/// **Not** what the forge is capable of. Every provider here can list its open pull requests over
/// its own API; a `false` below means nothing in this module asks. Reading the two as the same
/// thing is how `bitbucket` and `azuredevops` sat at `lists_pull_requests: false` while both had a
/// perfectly good list endpoint — one of them the very URL `create_bitbucket` already posts to.
///
/// These used to be predicates written out beside the dispatchers, each restating a provider list
/// the dispatcher's own arms already encoded. Two hand-kept lists that had to agree, with nothing
/// checking that they did — and either direction of drift is a user-visible bug. A predicate saying
/// yes where the dispatcher has no arm is an error toast on every poll; saying no where it does have
/// one hides a working feature with no message at all.
///
/// The predicates below now read this, and every dispatcher guards on it before matching, so there
/// is one answer rather than two that happen to coincide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForgeCapabilities {
    /// [`list_open_pull_requests`] — the project-wide open list every card is detected from.
    pub lists_pull_requests: bool,
    /// [`create_pull_request`].
    pub opens_pull_requests: bool,
    /// [`fetch_pull_request`] — state, title and the diff counts.
    pub reads_pull_requests: bool,
    /// [`fetch_ci_checks`] — checks enumerated by name, which is what the card's rollup needs.
    /// Weaker than it sounds: a forge can answer a CI *verdict* without enumerating anything.
    pub enumerates_checks: bool,
    /// [`fetch_ci_state`] — a verdict only, for the reconcile sweep.
    pub reports_ci_state: bool,
}

const NOTHING: ForgeCapabilities = ForgeCapabilities {
    lists_pull_requests: false,
    opens_pull_requests: false,
    reads_pull_requests: false,
    enumerates_checks: false,
    reports_ci_state: false,
};

/// The table. One row per provider string, and no two rows are the same shape — which is the reason
/// this is a table of booleans rather than a trait: Gitea shares GitHub's list endpoint but has its
/// own create, Bitbucket reports a CI verdict it cannot enumerate, GitLab has no batch path. A
/// `Forge` trait would force one grouping onto rows that genuinely disagree, and half its methods
/// would return "not supported" on every implementation.
///
/// An unknown provider gets [`NOTHING`], so a remote on a host nobody has taught Maestro about is
/// inert rather than an error on a timer.
pub fn capabilities(provider: &str) -> ForgeCapabilities {
    match provider {
        "github" => ForgeCapabilities {
            lists_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            enumerates_checks: true,
            reports_ci_state: true,
        },
        "gitlab" => ForgeCapabilities {
            lists_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            enumerates_checks: true,
            reports_ci_state: true,
        },
        // Gitea and Forgejo expose commit statuses, but the shape has moved between versions and no
        // answer at all is safer here than a wrong one.
        "gitea" | "forgejo" => ForgeCapabilities {
            lists_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            ..NOTHING
        },
        // A verdict without an enumeration: `ci_bitbucket` answers whether CI passed, but nothing
        // here reads Bitbucket's individual checks, so the card shows no rollup.
        "bitbucket" => ForgeCapabilities {
            lists_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            reports_ci_state: true,
            ..NOTHING
        },
        "azuredevops" => ForgeCapabilities {
            lists_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            ..NOTHING
        },
        _ => NOTHING,
    }
}

/// Whether this forge can be asked which pull requests it has open.
///
/// The question the whole detection path rests on: a session finds its pull request in that list,
/// and so does every worktree card. Named for the list rather than for the per-branch search it
/// used to guard, which no longer exists.
pub fn supports_pull_request_list(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).lists_pull_requests
}

/// Whether Maestro can open a pull request on this project's forge.
///
/// A different question from [`crate::integration::code_hosting_handlers::CodeHostingRung`]
/// `::Ready`, which only says a credential answered. A forge can be connected and still have no arm.
///
/// Takes the whole config rather than the provider name because `host` is the only thing that
/// separates Bitbucket Cloud from Bitbucket Server, which are two forges behind one provider
/// string — if support ever covered one and not the other, this is the only place with enough
/// information to say so.
pub fn supports_pull_requests(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).opens_pull_requests
}

/// Whether this forge will name its individual checks, rather than only answering a verdict.
///
/// The card's rollup needs names. Without this the panel polled [`fetch_ci_checks`] every ten
/// seconds against a forge that answers an empty list by construction — a list that never becomes
/// anything, so the "still waiting for CI to queue" rate applied forever.
pub fn enumerates_checks(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).enumerates_checks
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
) -> Result<PullRequestDetail, String> {
    match target.config.provider.as_str() {
        "github" => fetch_github(target, number).await,
        "gitlab" => fetch_gitlab(target, number).await,
        "gitea" | "forgejo" => fetch_gitea(target, number).await,
        "bitbucket" => fetch_bitbucket(target, number).await,
        "azuredevops" => fetch_azure_devops(target, number).await,
        other => Err(unsupported(other, "read pull requests")),
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
    if !capabilities(&target.config.provider).enumerates_checks {
        return Ok(Vec::new());
    }
    match target.config.provider.as_str() {
        "github" => checks_github(target, number, head_sha).await,
        _ => checks_gitlab(target, number).await,
    }
}

/// One pull request's checks, as the project-wide fetch returns them.
#[derive(Debug)]
pub struct PullRequestChecks {
    pub number: i64,
    /// The commit the checks describe. The frontend caches against it, so a poll that changed
    /// nothing re-uses the answer and a pushed commit asks a new question.
    pub head_sha: Option<String>,
    pub checks: Vec<PullRequestCheck>,
}

/// How many pull requests the per-request fallback will ask about before giving up.
///
/// Only reached when the batch query is unavailable. Answering twenty of fifty is a Worktrees view
/// where most cards have a CI mark, which is worth more than a view that spends a hundred requests
/// to be complete and exhausts the token's budget doing it.
const FALLBACK_PULL_REQUEST_LIMIT: usize = 20;

/// Every open pull request's checks, in one request where the forge allows it.
///
/// The Worktrees view needs all of them at once — its CI filter counts states across the whole
/// list, which it cannot do from data held one row at a time. Asked per pull request that was two
/// requests each on GitHub every poll, so a project with twenty open ones spent most of an hourly
/// budget on a view nobody was interacting with.
///
/// Forges without an arm answer an empty list rather than an error, matching [`fetch_ci_checks`]:
/// Gitea and Forgejo report no checks anywhere in this module, and a view showing no CI marks is
/// the same outcome they already had.
pub async fn fetch_open_pull_request_checks(
    target: &PullRequestTarget<'_>,
    open: &[ListedPullRequest],
) -> Result<Vec<PullRequestChecks>, String> {
    if !capabilities(&target.config.provider).enumerates_checks {
        return Ok(Vec::new());
    }
    match target.config.provider.as_str() {
        "github" => match checks_all_github(target).await {
            Ok(checks) => Ok(checks),
            // An old GitHub Enterprise, or a token without the scope its GraphQL endpoint wants.
            // Degrading to the per-request path costs requests but keeps the marks on the cards.
            Err(e) => {
                log::debug!("[github] batch check query unavailable, falling back: {}", e);
                fetch_checks_one_by_one(target, open).await
            }
        },
        _ => fetch_checks_one_by_one(target, open).await,
    }
}

/// The fallback, and GitLab's only path: [`fetch_ci_checks`] per pull request, capped.
///
/// Sequential rather than concurrent on purpose. This runs when the forge has already refused the
/// cheap question, and firing twenty parallel requests at an instance that may be rate-limiting us
/// is how a degraded path becomes an outage.
async fn fetch_checks_one_by_one(
    target: &PullRequestTarget<'_>,
    open: &[ListedPullRequest],
) -> Result<Vec<PullRequestChecks>, String> {
    let mut all = Vec::new();
    for entry in open.iter().take(FALLBACK_PULL_REQUEST_LIMIT) {
        // REST directly for GitHub rather than through `fetch_ci_checks`: reaching here means
        // GraphQL has already refused this target, and the dispatcher would try it again per pull
        // request — paying a failed request each time to rediscover what the batch call just found.
        let asked = match target.config.provider.as_str() {
            "github" => checks_github_rest(target, entry.head_sha.as_deref()).await,
            _ => fetch_ci_checks(target, entry.number, entry.head_sha.as_deref()).await,
        };
        match asked {
            Ok(checks) => all.push(PullRequestChecks {
                number: entry.number,
                head_sha: entry.head_sha.clone(),
                checks,
            }),
            // One unreadable pull request must not blank the CI marks on every other card.
            Err(e) => log::debug!("Could not read CI for pull request #{}: {}", entry.number, e),
        }
    }
    Ok(all)
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
    if !capabilities(&target.config.provider).reports_ci_state {
        return Ok(CiState::Unknown);
    }
    match target.config.provider.as_str() {
        "github" => ci_github(target, number, head_sha).await,
        "bitbucket" => ci_bitbucket(target, head_sha).await,
        _ => ci_gitlab(target, number).await,
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

    /// The whole matrix, written out, so changing what a forge can do is a deliberate edit here as
    /// well as in the table. Every row is also a claim about a dispatcher above having an arm: a
    /// `true` with no arm is an error on every poll, and a `false` where an arm exists is a feature
    /// the user never sees.
    #[test]
    fn every_forge_claims_only_what_a_dispatcher_answers() {
        // provider, (lists, opens, reads, enumerates checks, reports ci)
        let expected = [
            ("github", (true, true, true, true, true)),
            ("gitlab", (true, true, true, true, true)),
            ("gitea", (true, true, true, false, false)),
            ("forgejo", (true, true, true, false, false)),
            ("bitbucket", (true, true, true, false, true)),
            ("azuredevops", (true, true, true, false, false)),
            // Nothing at all, rather than an error on a timer, for a host nobody has taught us.
            ("sourcehut", (false, false, false, false, false)),
        ];

        for (provider, (lists, opens, reads, enumerates, reports)) in expected {
            let actual = capabilities(provider);
            assert_eq!(
                actual,
                ForgeCapabilities {
                    lists_pull_requests: lists,
                    opens_pull_requests: opens,
                    reads_pull_requests: reads,
                    enumerates_checks: enumerates,
                    reports_ci_state: reports,
                },
                "{}",
                provider
            );
        }
    }

    /// The two predicates the frontend gates on have to answer out of the same table the
    /// dispatchers do. Keeping them as separate provider lists is what let them drift.
    #[test]
    fn the_predicates_read_the_table() {
        assert!(supports_pull_request_list(&config("github", "github.com")));
        assert!(supports_pull_requests(&config("bitbucket", "bitbucket.org")));
        assert!(!supports_pull_request_list(&config("sourcehut", "git.sr.ht")));
        assert!(!supports_pull_requests(&config("sourcehut", "git.sr.ht")));
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
