//! Azure DevOps Services and Azure DevOps Server.
//!
//! The only forge here whose fetch endpoint takes no repository — a `pullRequestId` is unique per
//! *organization* — which is why [`credential_matches_coordinates`] exists and why every address
//! is built from the remote rather than from the credential that answered.
//!
//! The provider module this leans on shares its name with this one. It is imported by absolute
//! path below, because `super::azure_devops` from in here would mean *this* module.

use serde::Deserialize;

use super::{
    CreatedPullRequest, ListedPullRequest, PullRequestDetail, PullRequestState, PullRequestTarget,
};
use crate::integration::azure_devops::{AZDO_API_VERSION, make_azdo_auth, normalize_azdo_org_url};
use crate::integration::build_http_client;

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
            (normalize_azdo_org_url(instance), None)
        }
    };

    Ok(AzureDevOpsCoordinates {
        base,
        organization,
        project: project.to_string(),
        repository: repository.to_string(),
    })
}

/// The organization URL whose credential should answer for this remote.
///
/// `None` for a path this cannot read, and for an on-premises remote — where the base comes from
/// the credential in the first place, so there is nothing to prefer it by.
pub(super) fn preferred_base(host: &str, project_path: &str) -> Option<String> {
    azure_devops_coordinates(host, project_path, None).ok().map(|coordinates| coordinates.base)
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
    let credential_base = normalize_azdo_org_url(instance);

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
fn azure_devops_details(pr: AzureDevOpsPullRequestState) -> PullRequestDetail {
    // The only diagnosis that will ever exist for `failure` and `rejectedByPolicy`, both of which
    // this maps to `None` and therefore acts on nowhere else.
    if let Some(message) = &pr.merge_failure_message {
        log::debug!("Azure DevOps declined to merge pull request: {}", message);
    }
    PullRequestDetail::from_state(
        azure_devops_state(&pr.status),
        azure_devops_mergeable(pr.merge_status.as_deref()),
        pr.last_merge_source_commit.and_then(|commit| commit.commit_id),
    )
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
            AZDO_API_VERSION
        ))
        .header("Authorization", make_azdo_auth(token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let repository: AzureDevOpsRepository = azure_devops_json(response).await?;
    Ok(repository.id)
}

/// How many open pull requests one page covers. See `bitbucket::LIST_PAGE_SIZE` for why this is
/// asked for in one request rather than paginated.
const LIST_PAGE_SIZE: usize = 100;

#[derive(Deserialize)]
struct AzureDevOpsListEntry {
    #[serde(rename = "pullRequestId")]
    pull_request_id: i64,
    #[serde(default)]
    title: String,
    #[serde(rename = "sourceRefName", default)]
    source_ref_name: Option<String>,
    #[serde(rename = "targetRefName", default)]
    target_ref_name: Option<String>,
    #[serde(rename = "creationDate", default)]
    creation_date: Option<String>,
    #[serde(rename = "lastMergeSourceCommit", default)]
    last_merge_source_commit: Option<AzureDevOpsCommitRef>,
}

#[derive(Deserialize)]
struct AzureDevOpsListPage {
    #[serde(default)]
    value: Vec<AzureDevOpsListEntry>,
}

/// Azure DevOps names branches by full ref where a worktree row carries the bare name.
fn strip_refs_heads(name: String) -> String {
    name.strip_prefix("refs/heads/").map(str::to_string).unwrap_or(name)
}

/// `None` for an entry with no source ref: that is the field a worktree is matched on.
///
/// `head_sha` is the source head as of the last merge *attempt* rather than the live branch tip —
/// see [`azure_devops_details`]. Harmless while this provider answers no CI, but a future CI
/// implementation keyed on it would ask about a commit one rebase behind.
fn list_entry_to_listed(
    entry: AzureDevOpsListEntry,
    coordinates: &AzureDevOpsCoordinates,
) -> Option<ListedPullRequest> {
    Some(ListedPullRequest {
        number: entry.pull_request_id,
        // The response's own `url` is the REST resource, not a page a user can open.
        url: azure_devops_web_url(coordinates, entry.pull_request_id),
        title: entry.title,
        head_branch: strip_refs_heads(entry.source_ref_name?),
        base_branch: entry.target_ref_name.map(strip_refs_heads),
        created_at: entry.creation_date,
        head_sha: entry.last_merge_source_commit.and_then(|commit| commit.commit_id),
    })
}

/// Every active pull request on the repository.
///
/// Addressed by repository *name* rather than the id [`create_azure_devops`] resolves first: this
/// endpoint accepts either, and the name is already in the remote path — so the list costs one
/// request where creating one costs two.
pub(super) async fn list_azure_devops(
    target: &PullRequestTarget<'_>,
) -> Result<Vec<ListedPullRequest>, String> {
    let coordinates = azure_devops_coordinates(
        &target.config.host,
        &target.config.project_path,
        target.instance_url,
    )?;
    credential_matches_coordinates(&coordinates, target.instance_url)?;

    let response = build_http_client()?
        .get(format!(
            "{}/{}/_apis/git/repositories/{}/pullrequests\
             ?searchCriteria.status=active&$top={}&api-version={}",
            coordinates.base,
            coordinates.project,
            coordinates.repository,
            LIST_PAGE_SIZE,
            AZDO_API_VERSION
        ))
        .header("Authorization", make_azdo_auth(target.token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let page: AzureDevOpsListPage = azure_devops_json(response).await?;
    Ok(page.value.into_iter().filter_map(|entry| list_entry_to_listed(entry, &coordinates)).collect())
}

pub(super) async fn create_azure_devops(
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
            AZDO_API_VERSION
        ))
        .header("Authorization", make_azdo_auth(target.token))
        .json(&azure_devops_create_body(title, body, head, base))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let created: AzureDevOpsCreatedPullRequest = azure_devops_json(response).await?;
    Ok(CreatedPullRequest {
        number: created.pull_request_id,
        url: azure_devops_web_url(&coordinates, created.pull_request_id),
        head_sha: None,
    })
}

pub(super) async fn fetch_azure_devops(
    target: &PullRequestTarget<'_>,
    number: i64,
) -> Result<PullRequestDetail, String> {
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
            AZDO_API_VERSION
        ))
        .header("Authorization", make_azdo_auth(target.token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let pr: AzureDevOpsPullRequestState = azure_devops_json(response).await?;
    Ok(azure_devops_details(pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinates(host: &str, project_path: &str) -> AzureDevOpsCoordinates {
        azure_devops_coordinates(host, project_path, None).expect("path should parse")
    }

    fn azdo_listed(body: &str) -> Vec<ListedPullRequest> {
        let page: AzureDevOpsListPage = serde_json::from_str(body).expect("body should parse");
        let coordinates = coordinates("dev.azure.com", "fabrikam/MyProject/_git/MyRepo");
        page.value.into_iter().filter_map(|e| list_entry_to_listed(e, &coordinates)).collect()
    }

    /// Azure DevOps names branches by full ref, where a worktree row carries the bare name.
    /// Matching `refs/heads/feature` against `feature` finds nothing, silently.
    #[test]
    fn an_entry_maps_onto_the_shared_shape_with_the_refs_prefix_stripped() {
        let listed = azdo_listed(
            r#"{"count":1,"value":[{"pullRequestId":22,"title":"A new feature","status":"active",
                 "creationDate":"2026-09-01T16:30:31.6655471Z",
                 "sourceRefName":"refs/heads/npaulk/my_work",
                 "targetRefName":"refs/heads/new_feature",
                 "lastMergeSourceCommit":{"commitId":"b60280bc6e62e2f880f1b63c1e24987664d3bda3"}}]}"#,
        );
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].number, 22);
        assert_eq!(listed[0].head_branch, "npaulk/my_work");
        assert_eq!(listed[0].base_branch.as_deref(), Some("new_feature"));
        assert_eq!(
            listed[0].head_sha.as_deref(),
            Some("b60280bc6e62e2f880f1b63c1e24987664d3bda3")
        );
        // The response's own `url` is the REST resource, so the browser link is built here.
        assert_eq!(
            listed[0].url,
            "https://dev.azure.com/fabrikam/MyProject/_git/MyRepo/pullrequest/22"
        );
    }

    /// A branch name that genuinely has no `refs/heads/` prefix must survive untouched rather than
    /// losing its first eleven characters.
    #[test]
    fn a_bare_branch_name_is_left_alone() {
        assert_eq!(strip_refs_heads("refs/heads/main".to_string()), "main");
        assert_eq!(strip_refs_heads("main".to_string()), "main");
        assert_eq!(strip_refs_heads("refs/tags/v1".to_string()), "refs/tags/v1");
    }

    #[test]
    fn an_entry_with_no_source_ref_is_dropped() {
        assert!(azdo_listed(r#"{"value":[{"pullRequestId":1,"title":"x"}]}"#).is_empty());
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

    fn azdo_details(body: &str) -> PullRequestDetail {
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
}
