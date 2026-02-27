use std::sync::Arc;
use tauri::State;
use base64::Engine;
use chrono::Utc;

use crate::models::{AppSettings, SyncResult, GitHubIssue, JiraSearchResponse};
use crate::db::AppState;

/// Get current application settings from the database
///
/// Loads all stored settings including project paths, default model,
/// MCP allowlist defaults, and skills defaults.
///
/// # Arguments
/// * `app_state` - The application state containing the database connection
///
/// # Returns
/// * `Result<AppSettings, String>` - The current application settings or an error message
///
/// # Errors
/// Returns a string error if:
/// - The database lock cannot be acquired
/// - The settings cannot be loaded from the database
#[tauri::command]
#[specta::specta]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    println!("get_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Save application settings to the database
///
/// Persists all application settings including project paths, default model,
/// MCP allowlist defaults, and skills defaults to the settings table.
///
/// # Arguments
/// * `app_state` - The application state containing the database connection
/// * `settings` - The application settings to persist
///
/// # Returns
/// * `Result<(), String>` - Success or an error message
///
/// # Errors
/// Returns a string error if:
/// - The database lock cannot be acquired
/// - The settings cannot be saved to the database
#[tauri::command]
#[specta::specta]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    println!("save_settings() called via IPC");
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::save_settings(&mut *conn, &settings).map_err(|e| e.to_string())
}

/// Sync issues from GitHub repository
///
/// Fetches open issues from a GitHub repository using the GitHub REST API and
/// imports them as tasks into the specified project. Supports both creating new
/// tasks and updating existing ones if the issue has already been imported.
///
/// # Arguments
/// * `state` - The application state containing the database connection
/// * `project_id` - The ID of the project to import issues into
/// * `owner` - The GitHub repository owner
/// * `repo` - The GitHub repository name
/// * `token` - A GitHub personal access token with repo read permissions
///
/// # Returns
/// * `Result<SyncResult, String>` - A sync result containing imported/updated counts or an error
///
/// # Errors
/// Returns a string error if:
/// - The GitHub API request fails
/// - The response cannot be parsed as JSON
/// - The database lock cannot be acquired
/// - A database transaction fails
///
/// # Implementation Details
/// - Fetches only open issues (state=open)
/// - Retrieves up to 100 issues per request
/// - Creates a database transaction to ensure atomicity
/// - Uses the issue number as the external_id
/// - Sets all imported tasks to "Backlog" status initially
#[tauri::command]
#[specta::specta]
pub async fn sync_github_issues(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: String,
) -> Result<SyncResult, String> {
    println!("sync_github_issues() called: owner={}, repo={}, project_id={}", owner, repo, project_id);

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

    let mut imported_count = 0;
    let mut updated_count = 0;

    // Get database connection
    let mut conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Process each issue in a transaction
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let now = Utc::now().to_rfc3339();
    let external_id_str = "github";

    for issue in issues {
        let external_id = issue.number.to_string();
        let description = issue.body.unwrap_or_default();

        // Check if task already exists
        let existing_id: Option<i32> = tx
            .query_row(
                "SELECT id FROM tasks WHERE external_id = ? AND project_id = ?",
                rusqlite::params![&external_id, project_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(task_id) = existing_id {
            // Update existing task
            tx.execute(
                "UPDATE tasks SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&issue.title, &description, &now, task_id],
            )
            .map_err(|e| format!("Failed to update task: {}", e))?;
            updated_count += 1;
        } else {
            // Insert new task
            let skills_json = "[]";
            tx.execute(
                "INSERT INTO tasks (project_id, name, description, status, external_id, is_imported, import_source, skills, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    project_id,
                    &issue.title,
                    &description,
                    "Backlog",
                    &external_id,
                    true,
                    external_id_str,
                    skills_json,
                    &now,
                    &now
                ],
            )
            .map_err(|e| format!("Failed to insert task: {}", e))?;
            imported_count += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(SyncResult {
        imported_count,
        updated_count,
        error_message: None,
    })
}

/// Sync issues from Jira
///
/// Fetches issues from a Jira instance using the Jira REST API and imports them
/// as tasks into the specified project. Supports both creating new tasks and
/// updating existing ones if the issue has already been imported.
///
/// # Arguments
/// * `state` - The application state containing the database connection
/// * `project_id` - The ID of the project to import issues into
/// * `host` - The Jira instance hostname (e.g., "your-instance.atlassian.net")
/// * `email` - The Jira user email for authentication
/// * `api_token` - A Jira API token for the user
/// * `jql` - A Jira Query Language (JQL) string to filter issues (e.g., "project = PROJ AND status = 'To Do'")
///
/// # Returns
/// * `Result<SyncResult, String>` - A sync result containing imported/updated counts or an error
///
/// # Errors
/// Returns a string error if:
/// - The Jira API request fails
/// - The HTTP response indicates an error
/// - The response cannot be parsed as JSON
/// - The database lock cannot be acquired
/// - A database transaction fails
///
/// # Implementation Details
/// - Uses HTTP Basic authentication with base64 encoded credentials
/// - Sends JQL query as a request parameter
/// - Creates a database transaction to ensure atomicity
/// - Uses the issue key (e.g., "PROJ-123") as the external_id
/// - Sets all imported tasks to "Backlog" status initially
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
    println!("sync_jira_issues() called: host={}, project_id={}", host, project_id);

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

    let mut imported_count = 0;
    let mut updated_count = 0;

    // Get database connection
    let mut conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Process each issue in a transaction
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let now = Utc::now().to_rfc3339();
    let external_id_str = "jira";

    for issue in search_response.issues {
        let external_id = &issue.key;
        let description = issue.fields.description.unwrap_or_default();

        // Check if task already exists
        let existing_id: Option<i32> = tx
            .query_row(
                "SELECT id FROM tasks WHERE external_id = ? AND project_id = ?",
                rusqlite::params![external_id, project_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(task_id) = existing_id {
            // Update existing task
            tx.execute(
                "UPDATE tasks SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&issue.fields.summary, &description, &now, task_id],
            )
            .map_err(|e| format!("Failed to update task: {}", e))?;
            updated_count += 1;
        } else {
            // Insert new task
            let skills_json = "[]";
            tx.execute(
                "INSERT INTO tasks (project_id, name, description, status, external_id, is_imported, import_source, skills, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    project_id,
                    &issue.fields.summary,
                    &description,
                    "Backlog",
                    external_id,
                    true,
                    external_id_str,
                    skills_json,
                    &now,
                    &now
                ],
            )
            .map_err(|e| format!("Failed to insert task: {}", e))?;
            imported_count += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(SyncResult {
        imported_count,
        updated_count,
        error_message: None,
    })
}

/// Save import configuration to settings
///
/// Persists import provider configuration (GitHub or Jira) to the settings table
/// for later retrieval and reuse in subsequent import operations.
///
/// # Arguments
/// * `state` - The application state containing the database connection
/// * `project_id` - The ID of the project (for reference, not stored in config)
/// * `provider` - The import provider name ("github" or "jira")
/// * `config` - The configuration as a JSON value (provider-specific structure)
///
/// # Returns
/// * `Result<(), String>` - Success or an error message
///
/// # Errors
/// Returns a string error if:
/// - The provider is not "github" or "jira"
/// - The database lock cannot be acquired
/// - The config cannot be serialized to JSON
/// - The database INSERT fails
///
/// # Implementation Details
/// - Validates that provider is either "github" or "jira"
/// - Stores config as JSON string in settings table with key format: "import_config_{provider}"
/// - Uses INSERT OR REPLACE to update existing configs
/// - Records the timestamp of the save operation
#[tauri::command]
#[specta::specta]
pub fn save_import_config(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    provider: String,
    config: serde_json::Value,
) -> Result<(), String> {
    println!("save_import_config() called: provider={}, project_id={}", provider, project_id);

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
