use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::core::connection::get_project_with_git_conn;
use crate::git::remote::{parse_remote_url, pick_remote_url, ParsedRemote};
use crate::git::run_git_in_dir_lossy;
use crate::models::project::{now_rfc3339, ProjectConfig, ProjectIssueTrackingConfig};
use crate::models::issue_tracking::{DetectedIssueTracking, RemoteIssue};
use crate::models::integration::IntegrationCredentials;
use crate::integration::keychain::{KeychainOutcome, KeychainStore};

pub use super::issue_sync::*;
pub use super::image_proxy::*;

pub(super) fn extract_project_path(app_state: &AppState, project_id: i32) -> Result<String, String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("Project {} not found", project_id))
}

/// Read the ticketing field from .maestro/settings.json for the given project.
#[tauri::command]
#[specta::specta]
pub async fn get_project_issue_tracking_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Option<ProjectIssueTrackingConfig>, String> {
    let path = extract_project_path(&app_state, project_id)?;
    let config = ProjectConfig::load_from_project(&path).unwrap_or_default();
    Ok(config.issue_tracking)
}

/// Write the ticketing field into .maestro/settings.json for the given project.
#[tauri::command]
#[specta::specta]
pub async fn save_project_issue_tracking_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    issue_tracking: Option<ProjectIssueTrackingConfig>,
) -> Result<(), String> {
    let path = extract_project_path(&app_state, project_id)?;
    let mut config = ProjectConfig::load_from_project(&path).unwrap_or_default();
    // Clearing the config is an explicit "I don't want this here", so it also opts the
    // project out of git-remote detection — otherwise the next open would re-add it.
    config.issue_tracking_auto_detect = if issue_tracking.is_none() { Some(false) } else { None };
    config.issue_tracking = issue_tracking;
    config.updated_at = now_rfc3339();
    config.save_to_project(&path)
}

/// Map a git remote host to a ticketing provider.
///
/// Well-known public hosts map by name. Anything else is only resolved by matching the
/// host against the `instance_url` of a connection the user has already made — a
/// self-hosted Forgejo and a self-hosted Gitea are indistinguishable from their URL,
/// so guessing would be worse than not detecting.
fn provider_for_host(host: &str, app_state: &AppState) -> Option<String> {
    let well_known = match host {
        "github.com" => Some("github"),
        "gitlab.com" => Some("gitlab"),
        "codeberg.org" => Some("forgejo"),
        "dev.azure.com" | "ssh.dev.azure.com" => Some("azuredevops"),
        "bitbucket.org" => Some("bitbucket"),
        _ if host.ends_with(".visualstudio.com") => Some("azuredevops"),
        _ => None,
    };
    if let Some(provider) = well_known {
        return Some(provider.to_string());
    }

    stored_integrations(app_state)
        .into_iter()
        .find(|(_, creds)| creds.instance_url.as_deref().and_then(url_host).as_deref() == Some(host))
        .map(|(provider, _)| provider)
}

fn url_host(url: &str) -> Option<String> {
    crate::git::remote::parse_remote_url(&format!("{}/placeholder", url.trim_end_matches('/')))
        .map(|remote| remote.host)
}

fn stored_integrations(app_state: &AppState) -> Vec<(String, IntegrationCredentials)> {
    let app_data_dir = &app_state.app_data_dir;
    let mut found = Vec::new();
    for (provider, ids) in KeychainStore::read_registry(app_data_dir) {
        for id in &ids {
            if let Ok(KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds))) =
                KeychainStore::get_integration_by_id(&provider, id, app_data_dir)
            {
                found.push((provider.clone(), creds));
            }
        }
    }
    found
}

struct MatchedIntegration {
    id: String,
    token: String,
    instance_url: Option<String>,
}

/// Find credentials usable for `provider`, preferring an account whose instance URL is
/// the host we detected. Mirrors the CLI fallbacks `list_remote_issues` already applies,
/// so "connected" here means the same thing as "issues will actually load".
async fn find_integration(
    provider: &str,
    host: &str,
    app_state: &AppState,
) -> Option<MatchedIntegration> {
    let accounts: Vec<IntegrationCredentials> = stored_integrations(app_state)
        .into_iter()
        .filter(|(stored_provider, _)| stored_provider == provider)
        .map(|(_, creds)| creds)
        .collect();

    let matched = accounts
        .iter()
        .find(|creds| creds.instance_url.as_deref().and_then(url_host).as_deref() == Some(host))
        .or_else(|| accounts.first());

    if let Some(creds) = matched {
        return Some(MatchedIntegration {
            id: creds.id.clone(),
            token: creds.token.clone(),
            instance_url: creds.instance_url.clone(),
        });
    }

    match provider {
        "github" => crate::integration::github::try_gh_cli_token().await.map(|token| MatchedIntegration {
            id: "gh_cli".to_string(),
            token,
            instance_url: None,
        }),
        "gitlab" => crate::integration::gitlab::try_glab_cli_credentials().await.map(
            |(token, instance_url, _display_name)| MatchedIntegration {
                id: "glab_cli".to_string(),
                token,
                instance_url,
            },
        ),
        _ => None,
    }
}

/// Pull the provider-specific fields out of the remote path. Returns `None` for
/// providers with no issue support (`bitbucket`) or a path shape we don't recognise.
fn config_from_remote(provider: &str, remote: &ParsedRemote) -> Option<ProjectIssueTrackingConfig> {
    let mut config = ProjectIssueTrackingConfig {
        provider: provider.to_string(),
        integration_id: None,
        owner: None,
        repo: None,
        project_path: None,
        team_id: None,
        project_key: None,
        project_name: None,
    };

    let segments: Vec<&str> = remote.path.split('/').collect();

    match provider {
        "github" | "gitea" | "forgejo" => match segments.as_slice() {
            [owner, repo] => {
                config.owner = Some((*owner).to_string());
                config.repo = Some((*repo).to_string());
            }
            _ => return None,
        },
        "gitlab" => config.project_path = Some(remote.path.clone()),
        "azuredevops" => {
            let project = match segments.as_slice() {
                [_org, project, "_git", _repo] => *project,
                ["v3", _org, project, _repo] => *project,
                _ => return None,
            };
            config.project_name = Some(project.to_string());
        }
        _ => return None,
    }

    Some(config)
}

/// The fields `list_remote_issues` will demand for this provider.
fn has_required_fields(provider: &str, config: &ProjectIssueTrackingConfig) -> bool {
    match provider {
        "github" | "gitea" | "forgejo" => config.owner.is_some() && config.repo.is_some(),
        "gitlab" => config.project_key.is_some(),
        "azuredevops" => config.project_name.is_some(),
        _ => false,
    }
}

/// Work out the project's issue tracking config from its git remote, and write it into
/// `.maestro/settings.json` when everything needed is available.
///
/// Idempotent: a project that already has `issue_tracking` is never overwritten, so a
/// repeated call (React StrictMode, a second project open) reports `applied: false` and
/// changes nothing. Returns `None` when the remote is missing or its host maps to no
/// provider we can track issues with.
#[tauri::command]
#[specta::specta]
pub async fn detect_project_issue_tracking(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Option<DetectedIssueTracking>, String> {
    let (project, git_conn) = get_project_with_git_conn(&app_state, project_id).await?;
    let mut existing = ProjectConfig::load_from_project(&project.path).unwrap_or_default();

    let remotes = run_git_in_dir_lossy(&git_conn, &project.path, &["remote", "-v"]).await?;
    let Some(url) = pick_remote_url(&remotes) else {
        return Ok(None);
    };
    let Some(remote) = parse_remote_url(&url) else {
        log::debug!("Issue tracking detection: unrecognised remote URL {}", url);
        return Ok(None);
    };
    let Some(provider) = provider_for_host(&remote.host, &app_state) else {
        return Ok(None);
    };
    let Some(mut config) = config_from_remote(&provider, &remote) else {
        return Ok(None);
    };

    let integration = find_integration(&provider, &remote.host, &app_state).await;
    if let Some(integration) = &integration {
        config.integration_id = Some(integration.id.clone());

        // GitLab's issues endpoint is keyed by numeric project id, which only the API knows.
        if provider == "gitlab" {
            if let Some(project_path) = &config.project_path {
                let instance_url = integration
                    .instance_url
                    .clone()
                    .unwrap_or_else(|| format!("https://{}", remote.host));
                match crate::integration::gitlab::resolve_project_id(
                    &instance_url,
                    project_path,
                    &integration.token,
                )
                .await
                {
                    Ok(numeric_id) => config.project_key = Some(numeric_id.to_string()),
                    Err(e) => log::warn!("Issue tracking detection: GitLab project lookup failed: {}", e),
                }
            }
        }
    }

    let applied = integration.is_some()
        && existing.issue_tracking.is_none()
        && existing.issue_tracking_auto_detect != Some(false)
        && has_required_fields(&provider, &config);

    if applied {
        log::info!(
            "Detected {} issue tracking for project {} from git remote",
            provider,
            project_id
        );
        existing.issue_tracking = Some(config.clone());
        existing.updated_at = now_rfc3339();
        existing.save_to_project(&project.path)?;
    }

    Ok(Some(DetectedIssueTracking {
        provider,
        connected: integration.is_some(),
        applied,
        config,
    }))
}

/// Fetch remote issues using the global keychain for credentials and per-project
/// ticketing config for provider-specific fields (repo, project_key, etc.).
#[tauri::command]
#[specta::specta]
pub async fn list_remote_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<RemoteIssue>, String> {
    let path = extract_project_path(&app_state, project_id)?;

    let config = ProjectConfig::load_from_project(&path)
        .map_err(|_| "Failed to load project config".to_string())?;

    let ticketing = config
        .issue_tracking
        .ok_or_else(|| "No ticketing provider configured".to_string())?;

    let provider = &ticketing.provider;

    match provider.as_str() {
        "github" => {
            // Try stored account first (by integration_id or first-available), then gh CLI.
            let token = match get_integration_creds_for_project("github", &ticketing, &app_state) {
                Ok(creds) => creds.token,
                Err(_) => {
                    crate::integration::github::try_gh_cli_token()
                        .await
                        .ok_or_else(|| "No GitHub credentials found".to_string())?
                }
            };
            let owner = ticketing
                .owner
                .as_deref()
                .ok_or_else(|| "GitHub: owner required in project ticketing config".to_string())?;
            let repo = ticketing
                .repo
                .as_deref()
                .ok_or_else(|| "GitHub: repo required in project ticketing config".to_string())?;
            crate::integration::github::fetch_issues(owner, repo, &token).await
        }

        "gitlab" => {
            let (token, instance_url) = match get_integration_creds_for_project("gitlab", &ticketing, &app_state) {
                Ok(creds) => {
                    let url = creds
                        .instance_url
                        .ok_or_else(|| "GitLab: instance_url missing from stored credentials".to_string())?;
                    (creds.token, url)
                }
                Err(_) => {
                    let (cli_token, cli_url, _) = crate::integration::gitlab::try_glab_cli_credentials()
                        .await
                        .ok_or_else(|| "No GitLab credentials found".to_string())?;
                    let url = cli_url.unwrap_or_else(|| "https://gitlab.com".to_string());
                    (cli_token, url)
                }
            };
            let gitlab_project_id: i64 = ticketing
                .project_key
                .as_deref()
                .ok_or_else(|| "GitLab: project_key (numeric id) required in project ticketing config".to_string())?
                .parse()
                .map_err(|_| "GitLab: project_key must be a numeric project id".to_string())?;
            crate::integration::gitlab::fetch_issues(&instance_url, gitlab_project_id, &token).await
        }

        "forgejo" => {
            let creds = get_integration_creds_for_project("forgejo", &ticketing, &app_state)?;
            let instance_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "Forgejo: instance_url missing from stored credentials".to_string())?;
            let owner = ticketing
                .owner
                .as_deref()
                .ok_or_else(|| "Forgejo: owner required in project ticketing config".to_string())?;
            let repo = ticketing
                .repo
                .as_deref()
                .ok_or_else(|| "Forgejo: repo required in project ticketing config".to_string())?;
            crate::integration::forgejo::fetch_issues(instance_url, owner, repo, &creds.token).await
        }

        "linear" => {
            let creds = get_integration_creds_for_project("linear", &ticketing, &app_state)?;
            crate::integration::linear::fetch_issues(&creds.token, ticketing.team_id.as_deref()).await
        }

        "jira_cloud" => {
            let creds = get_integration_creds_for_project("jira_cloud", &ticketing, &app_state)?;
            let site_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "Jira Cloud: site_url missing from stored credentials".to_string())?;
            let email = creds
                .email
                .as_deref()
                .ok_or_else(|| "Jira Cloud: email missing from stored credentials".to_string())?;
            let project_key = ticketing
                .project_key
                .as_deref()
                .ok_or_else(|| "Jira Cloud: project_key required in project ticketing config".to_string())?;
            crate::integration::jira_cloud::fetch_issues(site_url, email, &creds.token, project_key).await
        }

        "jira_server" => Err("Jira Server is no longer supported — migrate to Jira Cloud".to_string()),

        "azuredevops" => {
            let creds = get_integration_creds_for_project("azuredevops", &ticketing, &app_state)?;
            let org_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "Azure DevOps: org_url missing from stored credentials".to_string())?;
            let project_name = ticketing
                .project_name
                .as_deref()
                .ok_or_else(|| "Azure DevOps: project_name required in project ticketing config".to_string())?;
            crate::integration::azure_devops::fetch_issues(org_url, project_name, &creds.token).await
        }

        "gitea" => {
            let creds = get_integration_creds_for_project("gitea", &ticketing, &app_state)?;
            let instance_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "Gitea: instance_url missing from stored credentials".to_string())?;
            let owner = ticketing
                .owner
                .as_deref()
                .ok_or_else(|| "Gitea: owner required in project ticketing config".to_string())?;
            let repo = ticketing
                .repo
                .as_deref()
                .ok_or_else(|| "Gitea: repo required in project ticketing config".to_string())?;
            crate::integration::gitea::fetch_issues(instance_url, owner, repo, &creds.token).await
        }

        "bitbucket" => Err("Bitbucket does not support issue tracking".to_string()),

        unknown => Err(format!("Unknown ticketing provider: {}", unknown)),
    }
}

/// Returns the first available credentials for a provider (for lookups that don't
/// belong to a specific project — e.g. project picker, image proxy).
pub(crate) fn get_integration_creds(
    provider: &str,
    app_state: &AppState,
) -> Result<IntegrationCredentials, String> {
    let app_data_dir = &app_state.app_data_dir;
    let registry = KeychainStore::read_registry(app_data_dir);
    if let Some(ids) = registry.get(provider) {
        for id in ids {
            if let Ok(KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds))) =
                KeychainStore::get_integration_by_id(provider, id, app_data_dir)
            {
                return Ok(creds);
            }
        }
    }
    Err(format!("No credentials found for {}", provider))
}

/// Resolve credentials for a project's issue tracking config.
/// If `ticketing.integration_id` is set, loads that specific account.
/// Otherwise falls back to the first account in the registry for the provider.
pub(crate) fn get_integration_creds_for_project(
    provider: &str,
    ticketing: &ProjectIssueTrackingConfig,
    app_state: &AppState,
) -> Result<IntegrationCredentials, String> {
    let app_data_dir = &app_state.app_data_dir;

    if let Some(id) = &ticketing.integration_id {
        match KeychainStore::get_integration_by_id(provider, id, app_data_dir)? {
            KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
                return Ok(creds);
            }
            _ => {}
        }
    }

    // Fall back to first available account in registry (covers legacy configs without integration_id).
    let registry = KeychainStore::read_registry(app_data_dir);
    if let Some(ids) = registry.get(provider) {
        for id in ids {
            if let Ok(KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds))) =
                KeychainStore::get_integration_by_id(provider, id, app_data_dir)
            {
                return Ok(creds);
            }
        }
    }

    Err(format!("No credentials found for {}", provider))
}
