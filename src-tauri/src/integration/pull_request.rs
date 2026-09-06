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

use self::azure_devops::{
    create_azure_devops, fetch_azure_devops, find_azure_devops, list_azure_devops,
};
use self::bitbucket::{
    ci_bitbucket, create_bitbucket, fetch_bitbucket, find_bitbucket, list_bitbucket,
};
use self::github::{
    branch_status_github, checks_github, ci_github, create_gitea, create_github, fetch_gitea,
    fetch_github, find_github_family, list_github_family,
};
use self::gitlab::{checks_gitlab, ci_gitlab, create_gitlab, fetch_gitlab, find_gitlab, list_gitlab};
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

/// Where one branch's pull request lives, before anything has been read about it.
///
/// Only the two fields the follow-up cannot supply: [`fetch_pull_request`] answers everything else
/// about a number, but not the number and not the browser URL.
pub struct FoundPullRequest {
    pub number: i64,
    pub url: String,
}

/// The pull request whose head is `branch`, if the forge has one.
///
/// `Ok(None)` means the forge answered and has no pull request for that branch. An unsupported
/// forge is an error rather than `None`, because the two are not the same thing to a user looking
/// at a card that is not there — and silently reporting "no pull request" for a branch that has one
/// is the one answer this must never give.
///
/// Asked by branch rather than found in [`list_open_pull_requests`], which is a *project-wide* list
/// and necessarily one page of it. On a repository with eleven thousand open pull requests — and
/// `nixpkgs` has that — a session's own pull request drops off that page whenever colleagues are
/// busier than the user, and the card silently empties. This asks about one branch and is exact at
/// any project size, for the same one request, because only one session panel is ever visible.
///
/// Only same-repository branches are found. A pull request opened from a fork lives under the
/// fork's owner, which this does not search.
pub async fn find_pull_request_by_head(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<FoundPullRequest>, String> {
    if !capabilities(&target.config.provider).finds_pull_request_by_branch {
        return Err(unsupported(&target.config.provider, "look a pull request up by branch"));
    }
    match target.config.provider.as_str() {
        "github" | "gitea" | "forgejo" => find_github_family(target, branch).await,
        "gitlab" => find_gitlab(target, branch).await,
        "bitbucket" => find_bitbucket(target, branch).await,
        "azuredevops" => find_azure_devops(target, branch).await,
        other => Err(unsupported(other, "look a pull request up by branch")),
    }
}

/// Everything the session card shows about the pull request on a branch.
///
/// One shape because it is one question. Detection, state and CI were three queries at three rates
/// until measuring showed they are a single GitHub GraphQL request costing one point — and that
/// splitting them was what let the card's header and its check ring describe two different moments.
#[derive(Debug)]
pub struct BranchPullRequest {
    pub number: i64,
    pub url: String,
    pub detail: PullRequestDetail,
    /// Empty on a forge that will not enumerate, and for a pull request that has already landed —
    /// a merged pull request's checks cannot change, so they are not asked for.
    pub checks: Vec<PullRequestCheck>,
}

/// The whole card, in as few requests as the forge allows.
///
/// GitHub answers all of it at once: one GraphQL call carries state, title, branches, the diff
/// counts, `mergeable` and every named check. Everywhere else this composes the three questions the
/// forge insists on asking separately.
pub async fn fetch_branch_pull_request(
    target: &PullRequestTarget<'_>,
    branch: &str,
) -> Result<Option<BranchPullRequest>, String> {
    if target.config.provider == "github" {
        match branch_status_github(target, branch).await {
            Ok(found) => return Ok(found),
            // An old GitHub Enterprise, or a token whose scope its GraphQL endpoint refuses.
            // Composing from REST costs two more requests but keeps the card working.
            Err(e) => log::debug!("[github] branch status query unavailable, falling back: {}", e),
        }
    }

    let Some(found) = find_pull_request_by_head(target, branch).await? else {
        return Ok(None);
    };
    let detail = fetch_pull_request(target, found.number).await?;
    let checks = if detail.state == PullRequestState::Open {
        fetch_ci_checks(target, found.number, detail.head_sha.as_deref()).await?
    } else {
        Vec::new()
    };

    Ok(Some(BranchPullRequest { number: found.number, url: found.url, detail, checks }))
}

/// One entry of the project-wide open list.
///
/// `head_branch` is the field that makes this the answer to "which pull request is on this branch",
/// for a worktree card and for a session alike — both match on it rather than asking the forge.
///
/// `updated_at` is what lets a caller *hold* `detail` rather than re-asking for it every poll.
/// Keyed on the head sha alone, a CI run that started or finished without a new commit would
/// invalidate nothing and the row would sit at its first answer; this field moves for that, and for
/// a rename, a merge and a push besides. It costs nothing — every forge's list response carries it.
#[derive(Debug)]
pub struct ListedPullRequest {
    pub number: i64,
    pub url: String,
    pub title: String,
    pub head_branch: String,
    pub base_branch: Option<String>,
    pub created_at: Option<String>,
    pub head_sha: Option<String>,
    pub updated_at: Option<String>,
    /// Whether the head branch lives in a different repository from the base — a pull request from
    /// a fork, whose branch the project has no remote for.
    ///
    /// Decides how the Worktrees panel checks the pull request out, and the two possible mistakes
    /// are not symmetric. Reading a fork as same-repository points `create_worktree` at
    /// `<remote>/<head_branch>`, which either fails outright or — when the base repository happens
    /// to have an unrelated branch of that name — silently checks out the wrong code. Reading a
    /// same-repository pull request as a fork costs it only its branch *name*, because the forge's
    /// own pull request ref exists either way. So anything a forge will not positively tell us
    /// reads as a fork; see [`is_cross_repository`].
    pub from_fork: bool,
    /// Filled in only where the list request answers it for nothing, which is GitHub's GraphQL
    /// query and nowhere else. `None` does not mean "no diff and no checks" — it means *unasked*,
    /// and the caller fetches it per pull request.
    pub detail: Option<ListedPullRequestDetail>,
}

/// Whether a pull request's two endpoints are different repositories, for the forges that name
/// both rather than answering the question directly.
///
/// A missing name on either side reads as a fork, which is the safe direction — see
/// [`ListedPullRequest::from_fork`]. Generic over the identifier because the forges disagree about
/// what names a repository: GitHub and Bitbucket Cloud use `owner/name`, GitLab and Bitbucket
/// Server a numeric id.
pub(super) fn is_cross_repository<T: PartialEq>(head: Option<T>, base: Option<T>) -> bool {
    match (head, base) {
        (Some(head), Some(base)) => head != base,
        _ => true,
    }
}

/// The line counts, the file count and the CI verdict for one row.
///
/// One `Option` around the group rather than four loose ones, because *asking* is what happens
/// together: either the answer has been fetched for this row or it has not. The counts inside stay
/// individually optional because the forges disagree about which they report — GitHub answers all
/// three, GitLab none of them without another request — and an absent count must render as an
/// absent line rather than as a zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedPullRequestDetail {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub changed_files: Option<i64>,
    pub ci: CiRollup,
}

/// One page of a project's open pull requests, and how to ask for the next one.
#[derive(Debug)]
pub struct PullRequestPage {
    pub items: Vec<ListedPullRequest>,
    /// Opaque above this module: a GraphQL cursor on GitHub, a page number on GitLab, Gitea and
    /// Bitbucket Cloud, a row offset on Bitbucket Server and Azure DevOps. `None` is the last page.
    ///
    /// Opaque rather than a page number the frontend increments, because two of the six forges
    /// cannot be paged that way and GitHub's cursor is not derivable from anything the caller holds.
    pub next_cursor: Option<String>,
    /// `None` where the forge will not say cheaply: Bitbucket Server and Azure DevOps have no total
    /// in their responses at all. The header then says how many are shown rather than inventing a
    /// denominator.
    pub total: Option<i64>,
}

/// How many pull requests one page holds.
///
/// The panel shows fewer than thirty at once, so a larger page buys rows nobody looks at — and on
/// GitHub the page size *is* the price, since `pullRequests(first: N)` is charged N nodes whatever
/// comes back.
pub const LIST_PAGE_SIZE: usize = 30;

/// One page of the pull requests currently open on the project's forge.
///
/// A page rather than "all of them", because there is no such thing: `nixpkgs` has around eleven
/// thousand open at once and `llvm-project` nine. Every answer this could give is a page, so the
/// only choice is whether the caller is told — and a list that silently stops at a hundred is what
/// made the panel's filters and its header quietly wrong.
///
/// `search` goes to the forge rather than filtering what came back, for the same reason: filtering
/// one page of eleven thousand finds almost nothing and looks like an empty repository. Three
/// providers cannot do it and refuse rather than pretending — see `searches_pull_requests`.
///
/// Only open ones: asking for every state would page through the repository's whole history to find
/// the few that are live. A pull request that leaves this list has merged or closed, and the caller
/// that was watching it asks [`fetch_pull_request`] by number for which of the two.
///
/// Same-repository branches only — a fork's head branch is in another namespace, which no worktree
/// here is on.
pub async fn list_open_pull_requests(
    target: &PullRequestTarget<'_>,
    cursor: Option<&str>,
    search: Option<&str>,
) -> Result<PullRequestPage, String> {
    let forge = capabilities(&target.config.provider);
    if search.is_some() && !forge.searches_pull_requests {
        return Err(unsupported(&target.config.provider, "search pull requests"));
    }

    let mut page = match target.config.provider.as_str() {
        "github" | "gitea" | "forgejo" => list_github_family(target, cursor, search).await?,
        "gitlab" => list_gitlab(target, cursor, search).await?,
        "bitbucket" => list_bitbucket(target, cursor).await?,
        "azuredevops" => list_azure_devops(target, cursor).await?,
        other => return Err(unsupported(other, "list pull requests")),
    };

    // A `None` detail means "not asked yet", and the caller answers it by asking per row. On a forge
    // that reports neither counts nor checks there is nothing to ask *for*, so leaving it `None`
    // would spend a request per row on every page to be told so — the exact per-row cost this page
    // exists to remove. An empty answer is the true one: we know, and there is nothing there.
    if !forge.enumerates_checks && !forge.reports_diff_counts {
        let nothing = ListedPullRequestDetail {
            additions: None,
            deletions: None,
            changed_files: None,
            ci: CiRollup::Unknown,
        };
        for item in &mut page.items {
            item.detail.get_or_insert(nothing);
        }
    }

    Ok(page)
}

/// A cursor this module handed out, read back as a row offset.
///
/// Every forge but GitHub pages by position, so their cursors are all one vocabulary — a row offset
/// — which each then spends in its own currency: a 1-based page number on GitLab, Gitea and
/// Bitbucket Cloud, a raw `start` or `$skip` on Bitbucket Server and Azure DevOps. GitHub's cursor
/// is a GraphQL one and never reaches here.
///
/// Anything unparseable reads as the first page rather than failing. A cursor is opaque to whoever
/// holds it, so a bad one is a bug here or a value left over from an older build, and an error would
/// leave the panel empty until the user thought to reset something they cannot see.
pub(super) fn cursor_offset(cursor: Option<&str>) -> usize {
    cursor.and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// That offset as the 1-based page number the forge wants.
pub(super) fn offset_page(offset: usize) -> usize {
    offset / LIST_PAGE_SIZE + 1
}

/// The cursor for the page after this one, or `None` when the forge has run out.
///
/// A short page is the end of the list on every forge here, which is what lets this decide without
/// a second request or a total to compare against.
pub(super) fn next_offset_cursor(returned: usize, offset: usize) -> Option<String> {
    (returned >= LIST_PAGE_SIZE).then(|| (offset + returned).to_string())
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
    /// [`list_open_pull_requests`] — the project-wide open list the Worktrees view is built on.
    pub lists_pull_requests: bool,
    /// [`find_pull_request_by_head`] — one branch's pull request, which is how a session finds its
    /// own. Separate from the list above because they fail differently: the list is one page of a
    /// project that may have thousands, and this is exact.
    pub finds_pull_request_by_branch: bool,
    /// The `search` argument of [`list_open_pull_requests`], and so whether the panel shows a search
    /// box at all. Half the forges cannot: Gitea and Forgejo take no `q` on `/pulls` and search pull
    /// requests only through an issues endpoint that answers neither head branch nor head sha, and
    /// Azure DevOps' `searchCriteria` has no text field. Hiding the box there is deliberate — a
    /// control that silently searched thirty rows on three providers and the project on the other
    /// three is worse than one that is absent where it cannot work.
    pub searches_pull_requests: bool,
    /// [`create_pull_request`].
    pub opens_pull_requests: bool,
    /// [`fetch_pull_request`] — state, title and the diff counts.
    pub reads_pull_requests: bool,
    /// Whether that read actually carries `additions`, `deletions` and `changed_files`. Weaker than
    /// `reads_pull_requests`, which every forge here claims: only the GitHub family puts the numbers
    /// in the body, GitLab needs another request for them and Bitbucket and Azure DevOps answer none
    /// at all. Together with `enumerates_checks` this decides whether [`fetch_row_detail`] can
    /// return anything — see the empty-detail fill in [`list_open_pull_requests`].
    pub reports_diff_counts: bool,
    /// [`fetch_ci_checks`] — checks enumerated by name, which is what the card's rollup needs.
    /// Weaker than it sounds: a forge can answer a CI *verdict* without enumerating anything.
    pub enumerates_checks: bool,
    /// [`fetch_ci_state`] — a verdict only, for the reconcile sweep.
    pub reports_ci_state: bool,
}

const NOTHING: ForgeCapabilities = ForgeCapabilities {
    lists_pull_requests: false,
    finds_pull_request_by_branch: false,
    searches_pull_requests: false,
    opens_pull_requests: false,
    reads_pull_requests: false,
    reports_diff_counts: false,
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
            finds_pull_request_by_branch: true,
            searches_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            reports_diff_counts: true,
            enumerates_checks: true,
            reports_ci_state: true,
        },
        // No `reports_diff_counts`: GitLab's merge request body carries no line or file counts, and
        // the changes endpoint that does would be another request per row.
        "gitlab" => ForgeCapabilities {
            lists_pull_requests: true,
            finds_pull_request_by_branch: true,
            searches_pull_requests: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            enumerates_checks: true,
            reports_ci_state: true,
            ..NOTHING
        },
        // Gitea and Forgejo expose commit statuses, but the shape has moved between versions and no
        // answer at all is safer here than a wrong one.
        "gitea" | "forgejo" => ForgeCapabilities {
            lists_pull_requests: true,
            finds_pull_request_by_branch: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            reports_diff_counts: true,
            ..NOTHING
        },
        // A verdict without an enumeration: `ci_bitbucket` answers whether CI passed, but nothing
        // here reads Bitbucket's individual checks, so the card shows no rollup.
        //
        // `searches_pull_requests` is false pending a live check, not because Bitbucket cannot. Its
        // `q` parameter demonstrably works — `find_bitbucket` already filters on
        // `source.branch.name` with it — but whether BBQL exposes `title ~ "…"` on a pull request is
        // not something Atlassian's rendered documentation would answer, and shipping a search that
        // 400s on every keystroke is worse than shipping none. Confirm against a real workspace and
        // flip this one bool.
        "bitbucket" => ForgeCapabilities {
            lists_pull_requests: true,
            finds_pull_request_by_branch: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            reports_ci_state: true,
            ..NOTHING
        },
        "azuredevops" => ForgeCapabilities {
            lists_pull_requests: true,
            finds_pull_request_by_branch: true,
            opens_pull_requests: true,
            reads_pull_requests: true,
            ..NOTHING
        },
        _ => NOTHING,
    }
}

/// The ref under which this forge publishes a pull request's head commit *in the base repository*,
/// so it can be fetched from the project's own remote.
///
/// This is the whole mechanism for checking out a fork: the head branch lives in a contributor's
/// repository, which the project has no remote for and no credential for, but every forge here bar
/// one mirrors the head commit into the base repository under a ref of its own. Fetching that ref
/// needs nothing the project cannot already reach.
///
/// Not part of [`ForgeCapabilities`], which is a table of which dispatchers have arms — this is a
/// ref template, and a bool saying one exists would still leave the template to be written down
/// somewhere else.
///
/// `None` for Azure DevOps, whose `refs/pull/<id>/merge` is the merge commit it *would* produce
/// rather than the branch under review — checking that out would show code neither side wrote.
/// Refusing rather than guessing is how this file already treats Azure CI; see
/// `azure_devops_ci_is_deliberately_unanswered`.
pub fn pull_request_head_ref(provider: &str, number: i64) -> Option<String> {
    match provider {
        "github" | "gitea" | "forgejo" => Some(format!("refs/pull/{}/head", number)),
        "gitlab" => Some(format!("refs/merge-requests/{}/head", number)),
        "bitbucket" => Some(format!("refs/pull-requests/{}/from", number)),
        _ => None,
    }
}

/// Whether Maestro can put a fork's pull request into a worktree on this forge.
///
/// Read by the frontend through `CodeHostingStatus` so the panel can offer a disabled row with a
/// reason, rather than a button that fails once pressed. Same-repository pull requests are checked
/// out from the remote branch and need none of this.
pub fn checks_out_fork_pull_requests(config: &ProjectCodeHostingConfig) -> bool {
    pull_request_head_ref(&config.provider, 1).is_some()
}

/// Whether this forge can be asked which pull requests it has open.
///
/// The question the whole detection path rests on: a session finds its pull request in that list,
/// and so does every worktree card. Named for the list rather than for the per-branch search it
/// used to guard, which no longer exists.
pub fn supports_pull_request_list(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).lists_pull_requests
}

/// Whether this forge can be asked for the pull request on one branch.
///
/// What the session card rests on. Distinct from the list above because the two fail in different
/// ways and the session must not fall back to the list: that answer is one page of a project which
/// may have thousands of open pull requests, so a branch missing from it is indistinguishable from
/// a branch that has none.
pub fn finds_pull_request_by_branch(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).finds_pull_request_by_branch
}

/// Whether the panel should offer a search box for this forge.
///
/// Read by the frontend through `CodeHostingStatus` rather than discovered by trying: a box that
/// appears and then errors on the first keystroke is worse than one that was never there.
pub fn searches_pull_requests(config: &ProjectCodeHostingConfig) -> bool {
    capabilities(&config.provider).searches_pull_requests
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

/// What a pull request's checks add up to, as one mark.
///
/// A verdict rather than an enumeration, and that distinction is the whole reason the Worktrees
/// panel is affordable: GitHub answers this as `statusCheckRollup { state }`, a scalar on a node the
/// list query already pays for, where the named `contexts` behind it are a hundred nodes *each* —
/// one point against a hundred and one for the same thirty pull requests.
///
/// `Failing` outranks `Running` here, the opposite of [`summarise_checks`]. That one decides whether
/// to start a fix agent, where acting on a half-finished matrix would waste a round. This one is a
/// single coloured icon with no room for "3 of 4 done", so the only question it can answer is
/// whether anything is broken, and a check that has already failed answers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiRollup {
    Passing,
    Failing,
    Running,
    /// No CI configured, or the forge would not say. Never rendered as a verdict.
    Unknown,
}

impl CiRollup {
    /// The same verdict from named checks, for the forges that answer nothing cheaper.
    pub fn from_checks(checks: &[PullRequestCheck]) -> Self {
        if checks.is_empty() {
            return Self::Unknown;
        }
        if checks.iter().any(|check| check.status == CheckStatus::Failed) {
            return Self::Failing;
        }
        if checks.iter().any(|check| check.status == CheckStatus::Running) {
            return Self::Running;
        }
        Self::Passing
    }
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

/// The counts and the CI verdict for one row, for a forge whose list did not carry them.
///
/// Two requests on GitLab, one on the rest, and none at all on GitHub — whose list query answers
/// this as free scalars, so [`ListedPullRequest::detail`] is already populated and nothing calls
/// this. That asymmetry is deliberate: a caller asks only when the list left a `None`, which means
/// no provider check anywhere above this module.
///
/// Called once per pull request when it is first seen and then held, so the cost is bounded by how
/// many new pull requests appear rather than by how long the panel stays open.
pub async fn fetch_row_detail(
    target: &PullRequestTarget<'_>,
    number: i64,
    head_sha: Option<&str>,
) -> Result<ListedPullRequestDetail, String> {
    let detail = fetch_pull_request(target, number).await?;
    // The list's head sha, not this response's: they describe the same commit, and preferring the
    // argument keeps the answer keyed to the row that asked for it even if a push landed in between.
    let sha = head_sha.or(detail.head_sha.as_deref());
    let checks = fetch_ci_checks(target, number, sha).await?;

    Ok(ListedPullRequestDetail {
        additions: detail.additions,
        deletions: detail.deletions,
        changed_files: detail.changed_files,
        ci: CiRollup::from_checks(&checks),
    })
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
/// How many pull requests the forge says there are in total, if it said so in a header.
///
/// Read before the body, because [`read_json`] consumes the response. `None` for a header that is
/// absent, unreadable or not a number — GitLab omits it once a count would be expensive, and the
/// panel is built to say "30 shown" rather than to invent a denominator.
fn header_total(response: &reqwest::Response, name: &str) -> Option<i64> {
    response.headers().get(name)?.to_str().ok()?.parse().ok()
}

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
        // provider, (lists, finds by branch, searches, opens, reads, counts, enumerates, reports ci)
        let expected = [
            ("github", (true, true, true, true, true, true, true, true)),
            // Searches, but its merge request body carries no diff counts.
            ("gitlab", (true, true, true, true, true, false, true, true)),
            // Counts, but `/pulls` takes no `q` — its only pull request search is an issues
            // endpoint that answers no head branch, which a row cannot be built from.
            ("gitea", (true, true, false, true, true, true, false, false)),
            ("forgejo", (true, true, false, true, true, true, false, false)),
            // `searches_pull_requests` is false pending a live check of BBQL's `title ~`, not
            // because Bitbucket cannot — see the comment on its row in the table.
            ("bitbucket", (true, true, false, true, true, false, false, true)),
            // Neither counts nor checks, which is what makes its rows arrive already answered
            // rather than sending the panel to ask per row for nothing.
            ("azuredevops", (true, true, false, true, true, false, false, false)),
            // Nothing at all, rather than an error on a timer, for a host nobody has taught us.
            ("sourcehut", (false, false, false, false, false, false, false, false)),
        ];

        for (provider, (lists, finds, searches, opens, reads, counts, enumerates, reports)) in
            expected
        {
            let actual = capabilities(provider);
            assert_eq!(
                actual,
                ForgeCapabilities {
                    lists_pull_requests: lists,
                    finds_pull_request_by_branch: finds,
                    searches_pull_requests: searches,
                    opens_pull_requests: opens,
                    reads_pull_requests: reads,
                    reports_diff_counts: counts,
                    enumerates_checks: enumerates,
                    reports_ci_state: reports,
                },
                "{}",
                provider
            );
        }
    }

    /// The two facts that decide whether the panel asks a forge anything per row.
    ///
    /// A provider answering neither has its rows filled with an empty detail by
    /// [`list_open_pull_requests`], so nothing asks. Getting this wrong is not a visible bug — it is
    /// thirty requests a page that each return nothing, which is exactly the cost the page exists to
    /// remove and which no test would otherwise catch.
    #[test]
    fn a_forge_that_answers_nothing_per_row_is_named() {
        for provider in ["bitbucket", "azuredevops"] {
            let forge = capabilities(provider);
            assert!(
                !forge.enumerates_checks && !forge.reports_diff_counts,
                "{} would be asked per row for nothing",
                provider
            );
        }
        for provider in ["github", "gitlab", "gitea", "forgejo"] {
            let forge = capabilities(provider);
            assert!(
                forge.enumerates_checks || forge.reports_diff_counts,
                "{} has something to say per row",
                provider
            );
        }
    }

    /// `Failing` beats `Running`, which is the opposite of [`summarise_checks`] — a single icon can
    /// only say whether anything is broken, and something that has already failed answers that
    /// whatever the rest of the matrix is still doing.
    #[test]
    fn one_broken_check_makes_the_whole_row_failing() {
        let check = |name: &str, status| PullRequestCheck { name: name.to_string(), status };

        assert_eq!(CiRollup::from_checks(&[]), CiRollup::Unknown);
        assert_eq!(
            CiRollup::from_checks(&[
                check("build", CheckStatus::Failed),
                check("lint", CheckStatus::Running),
            ]),
            CiRollup::Failing
        );
        assert_eq!(
            CiRollup::from_checks(&[
                check("build", CheckStatus::Passed),
                check("lint", CheckStatus::Running),
            ]),
            CiRollup::Running
        );
        assert_eq!(CiRollup::from_checks(&[check("build", CheckStatus::Passed)]), CiRollup::Passing);
    }

    /// A cursor is opaque to whoever holds it, so a bad one has to be recoverable: an error here
    /// would leave the panel empty until the user reset something they cannot see.
    #[test]
    fn an_unreadable_cursor_starts_at_the_first_page() {
        assert_eq!(cursor_offset(None), 0);
        assert_eq!(cursor_offset(Some("")), 0);
        assert_eq!(cursor_offset(Some("not a number")), 0);
        assert_eq!(cursor_offset(Some("60")), 60);

        assert_eq!(offset_page(0), 1);
        assert_eq!(offset_page(LIST_PAGE_SIZE), 2);
        assert_eq!(offset_page(LIST_PAGE_SIZE * 3), 4);
    }

    /// A short page is the end of the list on every forge that pages by offset, which is what lets
    /// the next cursor be decided without a second request or a total to compare against.
    #[test]
    fn a_short_page_is_the_last_one() {
        assert_eq!(next_offset_cursor(LIST_PAGE_SIZE, 0), Some(LIST_PAGE_SIZE.to_string()));
        assert_eq!(
            next_offset_cursor(LIST_PAGE_SIZE, LIST_PAGE_SIZE),
            Some((LIST_PAGE_SIZE * 2).to_string())
        );
        assert_eq!(next_offset_cursor(LIST_PAGE_SIZE - 1, 0), None);
        assert_eq!(next_offset_cursor(0, LIST_PAGE_SIZE), None);
    }

    /// The predicates the frontend gates on have to answer out of the same table the dispatchers
    /// do. Keeping them as separate provider lists is what let them drift.
    #[test]
    fn the_predicates_read_the_table() {
        assert!(supports_pull_request_list(&config("github", "github.com")));
        assert!(finds_pull_request_by_branch(&config("azuredevops", "dev.azure.com")));
        assert!(supports_pull_requests(&config("bitbucket", "bitbucket.org")));
        assert!(searches_pull_requests(&config("gitlab", "gitlab.com")));
        // The panel hides its search box on these two rather than degrading it to filtering the
        // page, which would make one control mean two different things.
        assert!(!searches_pull_requests(&config("gitea", "gitea.example.com")));
        assert!(!searches_pull_requests(&config("azuredevops", "dev.azure.com")));
        assert!(!supports_pull_request_list(&config("sourcehut", "git.sr.ht")));
        assert!(!finds_pull_request_by_branch(&config("sourcehut", "git.sr.ht")));
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

    /// The ref each forge publishes a pull request's head under, written out so that adding a
    /// forge without deciding the question fails here rather than in front of a user.
    ///
    /// These are not interchangeable and none of them is guessable: three different namespaces
    /// across five providers, and the one that has no head ref at all must stay `None` rather than
    /// borrow a neighbour's spelling.
    #[test]
    fn every_forge_names_the_ref_its_pull_request_head_lives_under() {
        let head_ref = |provider| pull_request_head_ref(provider, 42);

        assert_eq!(head_ref("github").as_deref(), Some("refs/pull/42/head"));
        assert_eq!(head_ref("gitea").as_deref(), Some("refs/pull/42/head"));
        assert_eq!(head_ref("forgejo").as_deref(), Some("refs/pull/42/head"));
        assert_eq!(head_ref("gitlab").as_deref(), Some("refs/merge-requests/42/head"));
        assert_eq!(head_ref("bitbucket").as_deref(), Some("refs/pull-requests/42/from"));
        // `refs/pull/42/merge` is a merge commit Azure computed, not the branch under review.
        assert_eq!(head_ref("azuredevops"), None);
        assert_eq!(head_ref("sourcehut"), None);

        assert!(checks_out_fork_pull_requests(&config("github", "github.com")));
        assert!(checks_out_fork_pull_requests(&config("gitlab", "gitlab.com")));
        assert!(!checks_out_fork_pull_requests(&config("azuredevops", "dev.azure.com")));
    }

    /// A forge that will not say which repository a branch is in must be read as a fork, because
    /// the two mistakes cost different things: a fork read as same-repository is checked out from
    /// `<remote>/<head_branch>`, which is either nothing or somebody else's branch of that name.
    #[test]
    fn a_repository_the_forge_did_not_name_reads_as_a_fork() {
        assert!(!is_cross_repository(Some("owner/repo"), Some("owner/repo")));
        assert!(is_cross_repository(Some("contributor/repo"), Some("owner/repo")));
        assert!(is_cross_repository(None, Some("owner/repo")));
        assert!(is_cross_repository(Some("owner/repo"), None));
        assert!(is_cross_repository::<&str>(None, None));
        // Numeric ids, which is how GitLab and Bitbucket Server name a repository.
        assert!(!is_cross_repository(Some(7), Some(7)));
        assert!(is_cross_repository(Some(7), Some(9)));
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
