use std::collections::HashSet;
use std::sync::Arc;

use base64::Engine as _;
use tauri::{Emitter, State};
use chrono::Utc;

use crate::db::AppState;
use crate::models::project::{now_rfc3339, ProjectConfig, ProjectIssueTrackingConfig};
use crate::models::issue_tracking::RemoteIssue;
use crate::models::{Project, Task, TASK_SELECT};
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
            // GitLab v4 API requires a numeric project id for issue listing; path lookup stores it in project_key.
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

    let already_imported: HashSet<String> = if issues.is_empty() {
        HashSet::new()
    } else {
        let external_ids: Vec<&str> = issues.iter().map(|i| i.external_id.as_str()).collect();
        let placeholders = external_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let query = format!(
            "SELECT external_id FROM tasks WHERE project_id = ? AND external_id IN ({})",
            placeholders
        );
        let mut all_params: Vec<&dyn rusqlite::ToSql> = vec![&project_id as &dyn rusqlite::ToSql];
        for id in &external_ids {
            all_params.push(id as &dyn rusqlite::ToSql);
        }
        let mut stmt = tx.prepare(&query).map_err(|e| e.to_string())?;
        let set: HashSet<String> = stmt
            .query_map(all_params.as_slice(), |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        set
    };

    let mut created_tasks: Vec<Task> = Vec::new();

    for issue in &issues {
        if already_imported.contains(&issue.external_id) {
            continue;
        }

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
                issue.body.as_deref(),
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
            issue.body.as_deref(),
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

const MAX_PROXY_IMAGE_SIZE: u64 = 10 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub async fn proxy_image(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    image_url: String,
) -> Result<String, String> {
    let bytes = if image_url.starts_with("http://") || image_url.starts_with("https://") {
        fetch_image_with_auth(&app_state, project_id, &image_url).await?
    } else if let Some(attachment_id) = image_url.strip_prefix("attachment:") {
        fetch_jira_attachment(&app_state, project_id, attachment_id).await?
    } else {
        read_local_or_remote_image(&app_state, project_id, &image_url).await?
    };

    if bytes.len() as u64 > MAX_PROXY_IMAGE_SIZE {
        return Err(format!(
            "Image too large ({:.1} MB, max 10 MB)",
            bytes.len() as f64 / 1_048_576.0
        ));
    }

    let mime = mime_from_bytes_or_url(&bytes, &image_url);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

async fn fetch_image_with_auth(
    app_state: &AppState,
    project_id: i32,
    url: &str,
) -> Result<Vec<u8>, String> {
    let client = crate::issue_tracking::build_http_client()?;

    let path = extract_project_path(app_state, project_id)?;
    let config = ProjectConfig::load_from_project(&path).ok();
    let ticketing = config.as_ref().and_then(|c| c.issue_tracking.as_ref());

    let mut request = client.get(url);

    if let Some(tc) = ticketing {
        if let Ok(creds) = get_integration_creds(&tc.provider, app_state) {
            request = match tc.provider.as_str() {
                "github" => request.header("Authorization", format!("Bearer {}", creds.token)),
                "gitlab" => request.header("PRIVATE-TOKEN", &creds.token),
                "jira_cloud" => {
                    let email = creds.email.as_deref().unwrap_or("");
                    let credentials = format!("{}:{}", email, creds.token);
                    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
                    request.header("Authorization", format!("Basic {}", auth))
                }
                "azuredevops" => {
                    let credentials = format!(":{}", creds.token);
                    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
                    request.header("Authorization", format!("Basic {}", auth))
                }
                "gitea" | "forgejo" => {
                    request.header("Authorization", format!("token {}", creds.token))
                }
                _ => request,
            };
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Download error: {}", e))
}

async fn fetch_jira_attachment(
    app_state: &AppState,
    project_id: i32,
    attachment_id: &str,
) -> Result<Vec<u8>, String> {
    let path = extract_project_path(app_state, project_id)?;
    let config = ProjectConfig::load_from_project(&path)
        .map_err(|_| "Failed to load project config".to_string())?;
    let ticketing = config
        .issue_tracking
        .ok_or_else(|| "No ticketing provider configured".to_string())?;

    if ticketing.provider != "jira_cloud" {
        return Err(format!(
            "attachment: scheme only supported for Jira, got {}",
            ticketing.provider
        ));
    }

    let creds = get_integration_creds("jira_cloud", app_state)?;
    let site_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Jira Cloud: site_url missing".to_string())?;
    let email = creds
        .email
        .as_deref()
        .ok_or_else(|| "Jira Cloud: email missing".to_string())?;

    let url = format!(
        "{}/rest/api/3/attachment/content/{}",
        site_url, attachment_id
    );
    let credentials = format!("{}:{}", email, creds.token);
    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());

    let client = crate::issue_tracking::build_http_client()?;
    let response = client
        .get(&url)
        .header("Authorization", format!("Basic {}", auth))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Jira attachment fetch failed: HTTP {}",
            response.status()
        ));
    }

    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Download error: {}", e))
}

async fn read_local_or_remote_image(
    app_state: &AppState,
    project_id: i32,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let project = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            Project::from_row,
        )
        .map_err(|e| format!("Project {} not found: {}", project_id, e))?
    };

    let full_path = if std::path::Path::new(file_path).is_absolute() {
        file_path.to_string()
    } else {
        format!("{}/{}", project.path.trim_end_matches('/'), file_path)
    };

    if project.is_remote() {
        let conn_id = project
            .connection_id
            .ok_or_else(|| "Remote project missing connection_id".to_string())?;
        let session = app_state
            .ssh
            .get_session(conn_id)
            .await
            .ok_or_else(|| "SSH session not active for this project".to_string())?;

        let cache_dir = app_state.app_data_dir.join("image_proxy_cache");
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("Cache dir creation failed: {}", e))?;

        let path_hash = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            full_path.hash(&mut hasher);
            hasher.finish()
        };
        let extension = std::path::Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let cache_path = cache_dir.join(format!("{}.{}", path_hash, extension));

        if cache_path.exists() {
            return tokio::fs::read(&cache_path)
                .await
                .map_err(|e| format!("Cannot read cached image: {}", e));
        }

        let transfer_id = format!("proxy-image-{}-{}", project_id, path_hash);
        crate::ssh::sftp::download_file(
            &session,
            &full_path,
            &cache_path,
            &transfer_id,
            &app_state.app_handle,
        )
        .await
        .map_err(|e| format!("SFTP download failed: {}", e))?;

        tokio::fs::read(&cache_path)
            .await
            .map_err(|e| format!("Cannot read downloaded image: {}", e))
    } else {
        tokio::fs::read(&full_path)
            .await
            .map_err(|e| format!("Cannot read image file: {}", e))
    }
}

fn mime_from_bytes_or_url(bytes: &[u8], url: &str) -> &'static str {
    if bytes.len() >= 12 {
        if bytes.starts_with(b"\x89PNG") {
            return "image/png";
        }
        if bytes.starts_with(b"\xFF\xD8\xFF") {
            return "image/jpeg";
        }
        if bytes.starts_with(b"GIF8") {
            return "image/gif";
        }
        if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            return "image/webp";
        }
    }
    let lower = url.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/png"
    }
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
