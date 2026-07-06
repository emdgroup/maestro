use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::models::project::{now_rfc3339, ProjectConfig, ProjectIssueTrackingConfig};
use crate::models::issue_tracking::RemoteIssue;
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
    config.issue_tracking = issue_tracking;
    config.updated_at = now_rfc3339();
    config.save_to_project(&path)
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
            let token = match KeychainStore::get_integration("github", &app_state.app_data_dir)? {
                KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
                    creds.token
                }
                KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
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
            let creds = get_integration_creds("gitlab", &app_state)?;
            let instance_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "GitLab: instance_url missing from stored credentials".to_string())?;
            let gitlab_project_id: i64 = ticketing
                .project_key
                .as_deref()
                .ok_or_else(|| "GitLab: project_key (numeric id) required in project ticketing config".to_string())?
                .parse()
                .map_err(|_| "GitLab: project_key must be a numeric project id".to_string())?;
            crate::integration::gitlab::fetch_issues(instance_url, gitlab_project_id, &creds.token).await
        }

        "forgejo" => {
            let creds = get_integration_creds("forgejo", &app_state)?;
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
            let creds = get_integration_creds("linear", &app_state)?;
            crate::integration::linear::fetch_issues(&creds.token, ticketing.team_id.as_deref()).await
        }

        "jira_cloud" => {
            let creds = get_integration_creds("jira_cloud", &app_state)?;
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
            let creds = get_integration_creds("azuredevops", &app_state)?;
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
            let creds = get_integration_creds("gitea", &app_state)?;
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

pub(crate) fn get_integration_creds(
    provider: &str,
    app_state: &AppState,
) -> Result<crate::models::integration::IntegrationCredentials, String> {
    match KeychainStore::get_integration(provider, &app_state.app_data_dir)? {
        KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
            Ok(creds)
        }
        KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
            Err(format!("No credentials found for {}", provider))
        }
    }
}
