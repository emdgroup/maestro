use std::sync::Arc;
use tauri::State;
use base64::Engine;
use chrono::Utc;

use crate::models::{AppSettings, SyncResult, GitHubIssue, JiraSearchResponse};
use crate::db::AppState;

/// Get current application settings from the database
#[tauri::command]
#[specta::specta]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Save application settings to the database
#[tauri::command]
#[specta::specta]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::save_settings(&mut conn, &settings).map_err(|e| e.to_string())
}

/// Upsert imported tasks from an external source (GitHub, Jira).
fn upsert_imported_tasks(
    tx: &rusqlite::Transaction,
    project_id: i32,
    import_source: &str,
    items: &[(String, String, String)],
    now: &str,
) -> Result<(i32, i32), String> {
    let mut imported_count = 0;
    let mut updated_count = 0;

    for (external_id, title, description) in items {
        let existing_id: Option<i32> = tx
            .query_row(
                "SELECT id FROM tasks WHERE external_id = ? AND project_id = ?",
                rusqlite::params![external_id, project_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(task_id) = existing_id {
            tx.execute(
                "UPDATE tasks SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![title, description, now, task_id],
            )
            .map_err(|e| format!("Failed to update task: {}", e))?;
            updated_count += 1;
        } else {
            tx.execute(
                "INSERT INTO tasks (project_id, name, description, status, external_id, is_imported, import_source, skills, created_at, updated_at)
                 VALUES (?, ?, ?, 'Backlog', ?, 1, ?, '[]', ?, ?)",
                rusqlite::params![project_id, title, description, external_id, import_source, now, now],
            )
            .map_err(|e| format!("Failed to insert task: {}", e))?;
            imported_count += 1;
        }
    }

    Ok((imported_count, updated_count))
}

/// Sync issues from GitHub repository
#[tauri::command]
#[specta::specta]
pub async fn sync_github_issues(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: String,
) -> Result<SyncResult, String> {
    // Construct GitHub API URL
    let url = format!("https://api.github.com/repos/{}/{}/issues?state=open&per_page=100", owner, repo);

    // Fetch from GitHub API
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from GitHub: {}", e))?;

    // Parse response
    let issues: Vec<GitHubIssue> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    // Build items for upsert
    let items: Vec<(String, String, String)> = issues
        .into_iter()
        .map(|issue| (issue.number.to_string(), issue.title, issue.body.unwrap_or_default()))
        .collect();

    // Get database connection and run upsert in a transaction
    let mut conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let now = Utc::now().to_rfc3339();
    let (imported_count, updated_count) = upsert_imported_tasks(&tx, project_id, "github", &items, &now)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(SyncResult {
        imported_count,
        updated_count,
        error_message: None,
    })
}

/// Sync issues from Jira
#[tauri::command]
#[specta::specta]
pub async fn sync_jira_issues(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<SyncResult, String> {
    // Construct Jira API URL with query parameters
    let encoded_jql = urlencoding::encode(&jql);
    let url = format!("https://{}/rest/api/3/search?jql={}", host, encoded_jql);

    // Create authorization header
    let credentials = format!("{}:{}", email, api_token);
    let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());

    // Fetch from Jira API
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Basic {}", encoded))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch from Jira: {}", e))?;

    // Check for HTTP errors
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("Jira API error: {}", status));
    }

    // Parse response
    let search_response: JiraSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira response: {}", e))?;

    // Build items for upsert
    let items: Vec<(String, String, String)> = search_response.issues
        .into_iter()
        .map(|issue| (issue.key, issue.fields.summary, issue.fields.description.unwrap_or_default()))
        .collect();

    // Get database connection and run upsert in a transaction
    let mut conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let now = Utc::now().to_rfc3339();
    let (imported_count, updated_count) = upsert_imported_tasks(&tx, project_id, "jira", &items, &now)?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(SyncResult {
        imported_count,
        updated_count,
        error_message: None,
    })
}

/// Save import configuration to settings
#[tauri::command]
#[specta::specta]
pub fn save_import_config(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    provider: String,
    config: serde_json::Value,
) -> Result<(), String> {
    let _ = project_id;

    // Validate provider
    if provider != "github" && provider != "jira" {
        return Err(format!("Invalid provider: {}. Must be 'github' or 'jira'", provider));
    }

    let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Serialize config to JSON string
    let config_json = serde_json::to_string(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Store in settings table
    let key = format!("import_config_{}", provider);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        rusqlite::params![&key, &config_json, &now],
    )
    .map_err(|e| format!("Failed to save import config: {}", e))?;

    Ok(())
}
