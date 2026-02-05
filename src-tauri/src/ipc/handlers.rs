use std::sync::Arc;
use tauri::State;
use base64::Engine;

use crate::models::{Project, Task, AppSettings, TaskStatus, SyncResult, GitHubIssue, JiraSearchResponse};
use crate::db::AppState;

/// Get list of all projects
#[tauri::command]
pub fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    println!("get_projects() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// Get or create project by path
#[tauri::command]
pub fn get_or_create_project(
    app_state: State<Arc<AppState>>,
    path: String,
) -> Result<Project, String> {
    println!("get_or_create_project({}) called via IPC", path);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Try to find existing project
    let existing: Result<Project, _> = conn.query_row(
        "SELECT id, name, path, created_at FROM projects WHERE path = ?",
        [&path],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    );

    if let Ok(project) = existing {
        return Ok(project);
    }

    // Create new project
    let now = chrono::Utc::now().to_rfc3339();
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    conn.execute(
        "INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![&name, &path, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    let project_id = conn.last_insert_rowid() as i32;

    Ok(Project {
        id: project_id,
        name,
        path,
        created_at: now,
    })
}

/// Get list of all tasks for a project
#[tauri::command]
pub fn get_tasks(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    println!("get_tasks({}) called via IPC", project_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at
             FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let tasks = stmt
        .query_map([project_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                acceptance_criteria: row.get(4)?,
                skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                status: match row.get::<_, String>(6)?.as_str() {
                    "Ready" => TaskStatus::Ready,
                    "InProgress" => TaskStatus::InProgress,
                    "Review" => TaskStatus::Review,
                    "Done" => TaskStatus::Done,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(tasks)
}

/// Create a new task with validation
#[tauri::command]
pub fn create_task(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    name: String,
    description: String,
    acceptance_criteria: String,
    skills: Vec<String>,
) -> Result<Task, String> {
    println!("create_task() called via IPC with name: {}", name);

    // Validate inputs
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() || trimmed_name.len() < 3 || trimmed_name.len() > 255 {
        return Err("Name must be 3-255 characters".to_string());
    }

    let trimmed_description = description.trim();
    if trimmed_description.is_empty() || trimmed_description.len() < 10 {
        return Err("Description must be at least 10 characters".to_string());
    }

    let trimmed_criteria = acceptance_criteria.trim();
    if trimmed_criteria.is_empty() || trimmed_criteria.len() < 10 {
        return Err("Acceptance criteria must be at least 10 characters".to_string());
    }

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();
    let skills_json = serde_json::to_string(&skills)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;

    conn.execute(
        "INSERT INTO tasks (project_id, name, description, acceptance_criteria, skills, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            project_id,
            &name,
            &description,
            &acceptance_criteria,
            &skills_json,
            "Backlog",
            &now,
            &now
        ],
    )
    .map_err(|e| e.to_string())?;

    let task_id = conn.last_insert_rowid() as i32;

    // Fetch and return created task
    let mut stmt = conn.prepare(
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at
         FROM tasks WHERE id = ?"
    )
    .map_err(|e| e.to_string())?;

    let task = stmt.query_row([task_id], |row| {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            acceptance_criteria: Some(row.get::<_, String>(4)?),
            skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
            status: match row.get::<_, String>(6)?.as_str() {
                "Ready" => TaskStatus::Ready,
                "InProgress" => TaskStatus::InProgress,
                "Review" => TaskStatus::Review,
                "Done" => TaskStatus::Done,
                _ => TaskStatus::Backlog,
            },
            external_id: row.get(7)?,
            is_imported: row.get(8)?,
            import_source: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })
    .map_err(|e| e.to_string())?;

    Ok(task)
}

/// Get application settings from database
#[tauri::command]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    println!("get_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Update a task's status or other fields
#[tauri::command]
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
) -> Result<Task, String> {
    println!("update_task({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    // Update status if provided
    if let Some(ref new_status) = status {
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_status, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Update description if provided
    if let Some(ref new_description) = description {
        conn.execute(
            "UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_description, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // If neither provided, at least update updated_at
    if status.is_none() && description.is_none() {
        conn.execute(
            "UPDATE tasks SET updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Fetch and return updated task
    conn.query_row(
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at FROM tasks WHERE id = ?",
        [task_id],
        |row| {
            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                acceptance_criteria: row.get(4)?,
                skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                status: match row.get::<_, String>(6)?.as_str() {
                    "Ready" => TaskStatus::Ready,
                    "InProgress" => TaskStatus::InProgress,
                    "Review" => TaskStatus::Review,
                    "Done" => TaskStatus::Done,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Save application settings to database
#[tauri::command]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    println!("save_settings() called via IPC with project_path: {:?}", settings.project_path);
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::save_settings(&mut *conn, &settings).map_err(|e| e.to_string())
}

/// Sync issues from GitHub repository
#[tauri::command]
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

    let now = chrono::Utc::now().to_rfc3339();
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
#[tauri::command]
pub async fn sync_jira_issues(
    state: State<'_, Arc<AppState>>,
    project_id: i32,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<SyncResult, String> {
    println!("sync_jira_issues() called: host={}, project_id={}", host, project_id);

    // Construct Jira API URL
    let url = format!("https://{}/rest/api/3/search", host);

    // Create authorization header
    let credentials = format!("{}:{}", email, api_token);
    let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());

    // Fetch from Jira API
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Basic {}", encoded))
        .query(&[("jql", jql.as_str())])
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

    let now = chrono::Utc::now().to_rfc3339();
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
#[tauri::command]
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

    let now = chrono::Utc::now().to_rfc3339();

    // Store in settings table
    let key = format!("import_config_{}", provider);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        rusqlite::params![&key, &config_json, &now],
    )
    .map_err(|e| format!("Failed to save import config: {}", e))?;

    Ok(())
}
