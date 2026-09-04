use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::core::AppState;
use crate::core::connection::get_project_with_git_conn;
use crate::core::project_storage::read_maestro_json;
use crate::git::remote::{
    pick_remote, parse_remote_url, redact_remote_url, url_for_remote, ParsedRemote,
};
use crate::git::run_git_in_dir_lossy;
use crate::integration::issue_tracking_handlers::{find_integration, provider_for_host};
use crate::models::project::{LandingMode, ProjectCodeHostingConfig, ProjectConfig};
use crate::project::settings::{mutate_project_config, SETTINGS_FILE};

/// How far up the capability ladder this project reaches.
///
/// Each rung removes one option from Approve and never blocks it; the bottom of the ladder
/// — merge locally — is always available and is not represented here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "PascalCase")]
#[specta(export)]
pub enum CodeHostingRung {
    /// No remote at all. Nothing to push to.
    NoRemote,
    /// A remote we can push to, on a host we cannot name. Plain git server, or a
    /// self-hosted forge nobody has connected an integration for yet.
    ForgeUnknown,
    /// The forge is known but no credential answered for it right now.
    NotConnected,
    /// A credential answered for the forge. Whether a pull request can be opened on it is a
    /// separate question — the ladder is about credentials, not about what the forge supports.
    /// See `CodeHostingStatus::forge_supports_pull_requests`.
    Ready,
}

/// The answer to "what can this project do with its remote", as of this moment.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CodeHostingStatus {
    pub rung: CodeHostingRung,
    /// What the user has chosen, not what is possible — `Merge` unless they said otherwise.
    pub landing_mode: LandingMode,
    /// Name of the remote to push to. Present at every rung above `NoRemote`, including
    /// the one where the forge is unknown, because push does not need a forge.
    pub remote: Option<String>,
    /// Where that remote points, with any embedded credential stripped by
    /// [`redact_remote_url`]. Set exactly when `remote` is: the settings page shows the two
    /// together, and a name with no URL beside it says nothing about which server it reaches.
    pub remote_url: Option<String>,
    /// Forge coordinates. `None` until the forge is identified.
    pub config: Option<ProjectCodeHostingConfig>,
    /// Whether Maestro can open a pull request on this forge at all.
    ///
    /// Deliberately not a rung: the ladder is a total order over credential state, and capability
    /// is orthogonal to it — a forge can be connected and still unsupported. Folding the two
    /// together would force a precedence choice and lose the distinction the UI needs, because
    /// "connect it in Settings" is the right prompt for an unconnected GitHub and a misleading one
    /// for a forge Maestro could not post to either way. `false` whenever the forge is unidentified.
    pub forge_supports_pull_requests: bool,
    /// Whether this forge can be asked for its open pull requests.
    ///
    /// Every detected card rests on this: a session finds its pull request in that list, and so
    /// does every worktree card. Separate from `forge_supports_pull_requests` because the two are
    /// different questions — opening one and enumerating them are different endpoints, and a forge
    /// could gain either first. Both views poll only when this is true, so a forge without a lister
    /// costs no requests rather than one failing request per cycle.
    pub forge_supports_pull_request_list: bool,
    /// Whether this forge will name its individual checks.
    ///
    /// Weaker than "has CI": Bitbucket reports a verdict Maestro can read without enumerating
    /// anything, and Gitea's commit-status shape has moved between versions. The card's rollup
    /// needs names, so it polls only when this is true — without it the checks query asks every ten
    /// seconds for a list that is empty by construction and can never become anything else.
    pub forge_enumerates_checks: bool,
    /// Whether this call wrote `code_hosting` into `.maestro/settings.json`.
    pub applied: bool,
}

/// Read the code-hosting field from `.maestro/settings.json`.
#[tauri::command]
#[specta::specta]
pub async fn get_project_code_hosting_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Option<ProjectCodeHostingConfig>, String> {
    let (_project, conn) = get_project_with_git_conn(&app_state, project_id).await?;
    let config: ProjectConfig = read_maestro_json(&conn, SETTINGS_FILE).await;
    Ok(config.code_hosting)
}

/// Write the code-hosting field into `.maestro/settings.json`.
#[tauri::command]
#[specta::specta]
pub async fn save_project_code_hosting_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    code_hosting: Option<ProjectCodeHostingConfig>,
) -> Result<(), String> {
    let (_project, conn) = get_project_with_git_conn(&app_state, project_id).await?;
    mutate_project_config(&conn, |config| {
        // Clearing is an explicit "not here", so it also opts out of detection — otherwise the
        // next status call would put it straight back.
        config.code_hosting_auto_detect = if code_hosting.is_none() { Some(false) } else { None };
        config.code_hosting = code_hosting;
        true
    })
    .await?;
    Ok(())
}

/// Choose how approved work leaves Review for this project.
#[tauri::command]
#[specta::specta]
pub async fn save_project_landing_mode(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    landing_mode: LandingMode,
) -> Result<(), String> {
    let (_project, conn) = get_project_with_git_conn(&app_state, project_id).await?;
    mutate_project_config(&conn, |config| {
        config.landing_mode = Some(landing_mode);
        true
    })
    .await?;
    Ok(())
}

/// Everything recoverable from the remote path without knowing what the forge's API will
/// want. Kept provider-agnostic on purpose: which of these fields an API call needs is
/// G2's problem, and guessing early would mean re-parsing when a provider is added.
fn hosting_from_remote(provider: &str, remote: &ParsedRemote) -> ProjectCodeHostingConfig {
    let segments: Vec<&str> = remote.path.split('/').collect();
    let (owner, repo) = match segments.as_slice() {
        [owner, repo] => (Some((*owner).to_string()), Some((*repo).to_string())),
        _ => (None, None),
    };

    ProjectCodeHostingConfig {
        provider: provider.to_string(),
        host: remote.host.clone(),
        owner,
        repo,
        project_path: remote.path.clone(),
    }
}

/// Work out what this project can do with its remote, and record the parts of the answer
/// that are the same for the whole team.
///
/// Deliberately re-run rather than cached: the top rung asks whether a credential answers
/// *right now*, which `gh auth token` can satisfy without any integration being stored, and
/// which stops being true when a token expires. Persisting it would let one teammate commit
/// a file promising another a PR path they do not have.
///
/// Idempotent on the write: a project that already has `code_hosting`, or that opted out, is
/// left alone and reports `applied: false`.
#[tauri::command]
#[specta::specta]
pub async fn get_project_code_hosting_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<CodeHostingStatus, String> {
    code_hosting_status(app_state.inner(), project_id).await
}

/// Non-IPC form of [`get_project_code_hosting_status`], for callers that already hold an
/// `AppState` — the approve path needs the remote name before it can push.
pub async fn code_hosting_status(
    app_state: &AppState,
    project_id: i32,
) -> Result<CodeHostingStatus, String> {
    let (project, git_conn) = get_project_with_git_conn(app_state, project_id).await?;
    // Read for reporting only. Nothing derived from this snapshot may reach the write below —
    // `git remote -v` runs in between, and this handler used to put the whole struct back
    // afterwards, undoing anything written during that window.
    let existing: ProjectConfig = read_maestro_json(&git_conn, SETTINGS_FILE).await;
    let landing_mode = existing.landing_mode.unwrap_or_default();

    let nothing = CodeHostingStatus {
        rung: CodeHostingRung::NoRemote,
        landing_mode,
        remote: None,
        remote_url: None,
        config: None,
        forge_supports_pull_requests: false,
        forge_supports_pull_request_list: false,
        forge_enumerates_checks: false,
        applied: false,
    };

    // A non-repository fails here too, which is correct: it has no remote either. Whether
    // Review exists at all is decided by `is_git_repo` long before this is asked.
    let remotes = match run_git_in_dir_lossy(&git_conn, &project.path, &["remote", "-v"]).await {
        Ok(output) => output,
        Err(e) => {
            log::debug!("Code hosting detection: `git remote -v` failed: {}", e);
            return Ok(nothing);
        }
    };
    // The project's configured remote, not merely the one we would have guessed. Everything
    // derived from this status pushes to it — `push_branch` and the pull request path both take
    // their remote from here — so guessing would silently ignore the setting and send an approved
    // branch to `origin` on a project that pushes somewhere else.
    let configured = crate::git::remote::project_remote(app_state, project_id).await;
    let picked = match url_for_remote(&remotes, &configured) {
        Some(url) => Some((configured, url)),
        // Either the configured remote has since been deleted, or there is none and
        // `project_remote` handed back its `origin` default for a repository that has no such
        // remote. Both are better served by what the repository actually has than by an error.
        None => pick_remote(&remotes),
    };
    let Some((remote_name, url)) = picked else {
        return Ok(nothing);
    };
    let remote_url = redact_remote_url(&url);
    let Some(remote) = parse_remote_url(&url) else {
        log::debug!("Code hosting detection: unrecognised remote URL {}", url);
        return Ok(nothing);
    };

    let Some(provider) = provider_for_host(&remote.host, app_state) else {
        // Pushable, but there is no forge to open anything against.
        return Ok(CodeHostingStatus {
            rung: CodeHostingRung::ForgeUnknown,
            landing_mode,
            remote: Some(remote_name),
            remote_url: Some(remote_url),
            config: None,
            forge_supports_pull_requests: false,
            forge_supports_pull_request_list: false,
            forge_enumerates_checks: false,
            applied: false,
        });
    };

    let config = hosting_from_remote(&provider, &remote);

    let applied = mutate_project_config(&git_conn, |fresh| {
        if fresh.code_hosting.is_some() || fresh.code_hosting_auto_detect == Some(false) {
            return false;
        }
        fresh.code_hosting = Some(config.clone());
        true
    })
    .await?;

    if applied {
        log::info!(
            "Detected {} code hosting for project {} from remote `{}`",
            provider,
            project_id,
            remote_name
        );
    }

    // `None` rather than the project's base: this only asks whether anything is connected, and
    // reporting `NotConnected` for a project whose credential the approve path would go on to find
    // would hide the pull request option over a question that was never asked here.
    let connected = find_integration(&provider, &remote.host, None, app_state).await.is_some();

    Ok(CodeHostingStatus {
        rung: if connected { CodeHostingRung::Ready } else { CodeHostingRung::NotConnected },
        landing_mode,
        remote: Some(remote_name),
        remote_url: Some(remote_url),
        forge_supports_pull_requests: crate::integration::pull_request::supports_pull_requests(
            &config,
        ),
        forge_supports_pull_request_list:
            crate::integration::pull_request::supports_pull_request_list(&config),
        forge_enumerates_checks: crate::integration::pull_request::enumerates_checks(&config),
        config: Some(config),
        applied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(host: &str, path: &str) -> ParsedRemote {
        ParsedRemote { host: host.to_string(), path: path.to_string() }
    }

    #[test]
    fn two_segment_paths_yield_owner_and_repo() {
        let config = hosting_from_remote("github", &remote("github.com", "owner/repo"));
        assert_eq!(config.owner.as_deref(), Some("owner"));
        assert_eq!(config.repo.as_deref(), Some("repo"));
        assert_eq!(config.project_path, "owner/repo");
        assert_eq!(config.host, "github.com");
    }

    #[test]
    fn deeper_paths_keep_the_whole_namespace_and_claim_no_owner() {
        let config = hosting_from_remote("gitlab", &remote("gitlab.com", "group/subgroup/repo"));
        assert_eq!(config.owner, None);
        assert_eq!(config.repo, None);
        assert_eq!(config.project_path, "group/subgroup/repo");
    }

    #[test]
    fn landing_mode_defaults_to_merge() {
        assert_eq!(LandingMode::default(), LandingMode::Merge);
        let config = ProjectConfig::default();
        assert_eq!(config.landing_mode.unwrap_or_default(), LandingMode::Merge);
    }
}
