use std::sync::Arc;

use tauri::{Emitter, State};
use chrono::Utc;

use crate::db::AppState;
use crate::models::project_config::{now_rfc3339, ProjectConfig, ProjectIssueTrackingConfig};
use crate::models::issue_tracking::RemoteIssue;
use crate::models::{Task, TASK_SELECT};
use crate::issue_tracking::keychain::{KeychainOutcome, KeychainStore};

fn extract_project_path(app_state: &AppState, project_id: i32) -> Result<String, String> {
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
pub async fn fetch_remote_issues(
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
            // First try global keychain, then fall back to gh CLI.
            let token = match KeychainStore::get_integration("github", &app_state.app_data_dir)? {
                KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
                    creds.token
                }
                KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
                    crate::issue_tracking::github::try_gh_cli_token()
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
            crate::issue_tracking::github::fetch_issues(owner, repo, &token).await
        }

        "gitlab" => {
            let creds = get_integration_creds("gitlab", &app_state)?;
            let instance_url = creds
                .instance_url
                .as_deref()
                .ok_or_else(|| "GitLab: instance_url missing from stored credentials".to_string())?;
            // project_path in ticketing config holds the GitLab project path (e.g. "group/project").
            // The numeric project_id is resolved via the GitLab API and stored in project_key as a string.
            let gitlab_project_id: i64 = ticketing
                .project_key
                .as_deref()
                .ok_or_else(|| "GitLab: project_key (numeric id) required in project ticketing config".to_string())?
                .parse()
                .map_err(|_| "GitLab: project_key must be a numeric project id".to_string())?;
            crate::issue_tracking::gitlab::fetch_issues(instance_url, gitlab_project_id, &creds.token).await
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
            crate::issue_tracking::forgejo::fetch_issues(instance_url, owner, repo, &creds.token).await
        }

        "linear" => {
            let creds = get_integration_creds("linear", &app_state)?;
            crate::issue_tracking::linear::fetch_issues(&creds.token, ticketing.team_id.as_deref()).await
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
            crate::issue_tracking::jira_cloud::fetch_issues(site_url, email, &creds.token, project_key).await
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
            crate::issue_tracking::azure_devops::fetch_issues(org_url, project_name, &creds.token).await
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
            crate::issue_tracking::gitea::fetch_issues(instance_url, owner, repo, &creds.token).await
        }

        "bitbucket" => Err("Bitbucket does not support issue tracking".to_string()),

        unknown => Err(format!("Unknown ticketing provider: {}", unknown)),
    }
}

fn get_integration_creds(
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

/// Batch-import remote issues as Backlog tasks for a project, skipping any that have already
/// been imported (by external_id + project_id). Returns the list of newly-created tasks.
#[tauri::command]
#[specta::specta]
pub async fn import_tasks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    issues: Vec<RemoteIssue>,
    base_branch: String,
) -> Result<Vec<Task>, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    let mut created_tasks: Vec<Task> = Vec::new();

    for issue in &issues {
        // Security: scope duplicate check to project_id — external_id is not globally unique
        // (e.g. "github:42" may appear in multiple projects for different repos)
        let exists: bool = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE external_id = ? AND project_id = ?",
            rusqlite::params![&issue.external_id, project_id],
            |row| row.get::<_, i64>(0),
        ).map(|count| count > 0).unwrap_or(false);

        if exists {
            continue;
        }

        // Security: validate field lengths to prevent oversized inserts
        if issue.title.len() > 1000 || issue.external_id.len() > 200 {
            return Err(format!("Issue fields exceed maximum allowed length: {}", issue.external_id));
        }

        let import_source = issue.external_id.split(':').next().unwrap_or("").to_string();

        let priority_str = match issue.priority.as_deref() {
            Some("Urgent") => "Urgent",
            Some("High") => "High",
            Some("Medium") => "Medium",
            Some("Low") => "Low",
            _ => "None",
        };

        let labels_json = serde_json::to_string(&issue.labels)
            .map_err(|e| format!("JSON serialization failed: {}", e))?;

        tx.execute(
            "INSERT INTO tasks (project_id, title, description, status, priority, base_branch, \
             is_imported, import_source, external_id, external_url, external_updated_at, \
             labels, skills, created_at, updated_at) \
             VALUES (?, ?, ?, 'Backlog', ?, ?, 1, ?, ?, ?, ?, ?, '[]', ?, ?)",
            rusqlite::params![
                project_id,
                &issue.title,
                issue.body.as_deref().unwrap_or(""),
                priority_str,
                &base_branch,
                &import_source,
                &issue.external_id,
                &issue.url,
                &issue.updated_at,
                labels_json,
                &now,
                &now,
            ],
        ).map_err(|e| e.to_string())?;

        let task_id = tx.last_insert_rowid();
        let query = format!("{} WHERE id = ?", TASK_SELECT);
        let task = tx.query_row(&query, [task_id], Task::from_row)
            .map_err(|e| e.to_string())?;
        created_tasks.push(task);
    }

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(created_tasks)
}

/// Update a task's title, description, labels, and external_updated_at from a remote issue.
/// This is the "Update task" action in the Changed tab — performs a non-destructive content overwrite.
#[tauri::command]
#[specta::specta]
pub fn update_task_from_remote(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    issue: RemoteIssue,
) -> Result<Task, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let labels_json = serde_json::to_string(&issue.labels)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;

    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    tx.execute(
        "UPDATE tasks SET title = ?, description = ?, labels = ?, \
         external_updated_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![
            &issue.title,
            issue.body.as_deref().unwrap_or(""),
            labels_json,
            &issue.updated_at,
            &now,
            task_id,
        ],
    ).map_err(|e| e.to_string())?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = tx.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Advance a task's external_updated_at to the remote value, clearing the "changed" flag
/// without modifying title, description, or labels.
#[tauri::command]
#[specta::specta]
pub fn dismiss_task_change(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    remote_updated_at: String,
) -> Result<Task, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    tx.execute(
        "UPDATE tasks SET external_updated_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&remote_updated_at, &now, task_id],
    ).map_err(|e| e.to_string())?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = tx.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "Wave 0 stub — implement after import_tasks is wired"]
    fn test_import_tasks_skips_duplicates() {
        // Verify that import_tasks does not insert a task whose external_id
        // already exists for the same project_id.
    }

    #[test]
    #[ignore = "Wave 0 stub — implement after update_task_from_remote is wired"]
    fn test_update_task_from_remote_overwrites_fields() {
        // Verify that update_task_from_remote updates title, description,
        // labels, and external_updated_at without touching other fields.
    }

    #[test]
    #[ignore = "Wave 0 stub — implement after dismiss_task_change is wired"]
    fn test_dismiss_task_change_advances_external_updated_at() {
        // Verify that dismiss_task_change updates external_updated_at to the
        // remote value without changing title, description, or labels.
    }
}
