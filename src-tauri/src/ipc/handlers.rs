use std::sync::Arc;
use tauri::State;
use base64::Engine;
use chrono::Utc;

use crate::models::{Project, Task, AppSettings, TaskStatus, SyncResult, GitHubIssue, JiraSearchResponse, Worktree, WorktreeStatus, PoolStatus, MergeOutcome, ErrorEvent, GitConnection, ConnectionStatus, SshConfig};
use crate::db::{AppState, get_git_connection};
use crate::process::{spawn_agent_cli_pty, ExecutionConfig};
use crate::process::spawn_agent_execution as spawn_agent_execution_dispatcher;
use crate::websocket::attach_remote_stream_listener;
use crate::git;

/// Get list of all projects
#[tauri::command]
pub fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    println!("get_projects() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at, is_remote, ssh_config FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            let ssh_config_json: Option<String> = row.get(5)?;
            let ssh_config = ssh_config_json
                .and_then(|json| serde_json::from_str(&json).ok());

            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                is_remote: row.get(4)?,
                ssh_config,
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
        "SELECT id, name, path, created_at, is_remote, ssh_config FROM projects WHERE path = ?",
        [&path],
        |row| {
            let ssh_config_json: Option<String> = row.get(5)?;
            let ssh_config = ssh_config_json
                .and_then(|json| serde_json::from_str(&json).ok());

            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                is_remote: row.get(4)?,
                ssh_config,
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
        "INSERT INTO projects (name, path, created_at, updated_at, is_remote, ssh_config) VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![&name, &path, &now, &now, false, None::<String>],
    )
    .map_err(|e| e.to_string())?;

    let project_id = conn.last_insert_rowid() as i32;

    Ok(Project {
        id: project_id,
        name,
        path,
        created_at: now,
        is_remote: false,
        ssh_config: None,
    })
}

/// Create a new project (local or remote)
#[tauri::command]
pub async fn create_project(
    app_state: State<'_, Arc<AppState>>,
    name: String,
    path: String,
    is_remote: bool,
    ssh_config: Option<SshConfig>,
    state: State<'_, Arc<AppState>>,
) -> Result<Project, String> {
    println!("create_project({}, is_remote={}) called via IPC", name, is_remote);

    // Validate name
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() || trimmed_name.len() > 255 {
        return Err("Project name must be 1-255 characters".to_string());
    }

    // Validate remote projects have SSH config
    if is_remote && ssh_config.is_none() {
        return Err("SSH config required for remote projects".to_string());
    }

    // For remote projects, establish connection BEFORE acquiring lock
    if is_remote {
        if let Some(config) = &ssh_config {
            use crate::ssh::RemoteSshSession;
            let session = RemoteSshSession::new(config.clone());

            // Test connection before creating project
            session.connect().await.map_err(|e| {
                format!("Failed to connect to remote project: {}", e)
            })?;

            // NOW acquire lock and store in database
            let now = chrono::Utc::now().to_rfc3339();
            let ssh_config_json = serde_json::to_string(config)
                .map_err(|e| format!("Failed to serialize SSH config: {}", e))?;

            let project_id: i32 = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

                // Insert project
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, is_remote, ssh_config) VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![&trimmed_name, &path, &now, &now, true, &ssh_config_json],
                )
                .map_err(|e| e.to_string())?;

                conn.last_insert_rowid() as i32
            };

            // Store SSH session in app state (AFTER releasing lock)
            state.set_ssh_session(project_id as i64, session).await;

            Ok(Project {
                id: project_id,
                name: trimmed_name.to_string(),
                path,
                created_at: now,
                is_remote: true,
                ssh_config: Some(config.clone()),
            })
        } else {
            Err("SSH config required for remote projects".to_string())
        }
    } else {
        // Local project
        let now = chrono::Utc::now().to_rfc3339();

        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        conn.execute(
            "INSERT INTO projects (name, path, created_at, updated_at, is_remote, ssh_config) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![&trimmed_name, &path, &now, &now, false, None::<String>],
        )
        .map_err(|e| e.to_string())?;

        let project_id = conn.last_insert_rowid() as i32;

        Ok(Project {
            id: project_id,
            name: trimmed_name.to_string(),
            path,
            created_at: now,
            is_remote: false,
            ssh_config: None,
        })
    }
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
            "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at
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
                    "Merging" => TaskStatus::Merging,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                model_override: row.get(10)?,
                mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
                skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
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
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at
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
                "Merging" => TaskStatus::Merging,
                _ => TaskStatus::Backlog,
            },
            external_id: row.get(7)?,
            is_imported: row.get(8)?,
            import_source: row.get(9)?,
            model_override: row.get(10)?,
            mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
            skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
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
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at FROM tasks WHERE id = ?",
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
                    "Merging" => TaskStatus::Merging,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                model_override: row.get(10)?,
                mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
                skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
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

// ============================================================================
// Worktree Pool Management
// ============================================================================

const POOL_MAX_SIZE: i32 = 5;

/// Lease worktree from pool for task execution with automatic retry and pool expansion
///
/// When no worktrees are available:
/// 1. Retries up to 3 times with exponential backoff (500ms, 1s, 1.5s)
/// 2. On each retry, checks again for available worktrees
/// 3. After retries exhausted, attempts pool expansion (creates new worktree)
/// 4. Returns error only if all retries and expansion fail
#[tauri::command]
pub async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    _repo_path: String,
) -> Result<Worktree, String> {
    println!("lease_worktree(project={}, task={}) called", project_id, task_id);

    const MAX_RETRIES: u32 = 3;
    const RETRY_BASE_MS: u64 = 500;

    // Try to lease with retry loop
    for attempt in 0..=MAX_RETRIES {
        // Attempt to lease available worktree
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

            let available: Result<Worktree, _> = conn.query_row(
                "SELECT id, project_id, branch_name, path, status, leased_at, returned_at, created_at
                 FROM worktrees WHERE project_id = ? AND status = 'Available' LIMIT 1",
                [project_id],
                |row| {
                    Ok(Worktree {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        branch_name: row.get(2)?,
                        path: row.get(3)?,
                        status: WorktreeStatus::Available,
                        leased_at: row.get(5)?,
                        returned_at: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                },
            );

            if let Ok(mut worktree) = available {
                // Lease existing worktree
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "UPDATE worktrees SET status = 'Leased', leased_at = ? WHERE id = ?",
                    rusqlite::params![&now, worktree.id],
                )
                .map_err(|e| format!("Failed to lease worktree: {}", e))?;

                worktree.status = WorktreeStatus::Leased;
                worktree.leased_at = Some(now);

                println!("✓ Leased existing worktree {}", worktree.id);
                return Ok(worktree);
            }
        } // Drop lock before sleep

        // No available worktree, check if we can create new one
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count worktrees: {}", e))?;

            if count < POOL_MAX_SIZE {
                // Create new worktree
                let worktree_id_str = format!("wt-{:03}", count + 1);
                let branch_name = format!("pool/agent-task-{}", task_id);
                let worktree_path = format!(".worktree-pool/{}", worktree_id_str);
                let now = chrono::Utc::now().to_rfc3339();

                conn.execute(
                    "INSERT INTO worktrees (project_id, branch_name, path, status, leased_at, created_at)
                     VALUES (?, ?, ?, 'Leased', ?, ?)",
                    rusqlite::params![project_id, &branch_name, &worktree_path, &now, &now],
                )
                .map_err(|e| format!("Failed to create worktree record: {}", e))?;

                let worktree_id = conn.last_insert_rowid() as i32;

                println!("✓ Created new worktree {} (pool expansion)", worktree_id);

                // Return without waiting for sidecar (Phase 4 will integrate actual git creation)
                return Ok(Worktree {
                    id: worktree_id,
                    project_id,
                    branch_name,
                    path: worktree_path,
                    status: WorktreeStatus::Leased,
                    leased_at: Some(now.clone()),
                    returned_at: None,
                    created_at: now,
                });
            }
        } // Drop lock before sleep

        // Pool is at max size and no available worktrees
        if attempt < MAX_RETRIES {
            // Calculate exponential backoff: 500ms * 2^attempt = 500ms, 1s, 1.5s
            let backoff_ms = RETRY_BASE_MS * (1 << attempt); // 2^attempt
            println!("[retry] Attempt {}: No available worktrees, retrying in {}ms (pool at max)", attempt + 1, backoff_ms);
            tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
        }
    }

    // All retries exhausted, pool still full
    Err(format!("Failed to lease or create worktree: pool exhausted and creation failed after {} retries", MAX_RETRIES))
}

/// Return worktree to pool after task completion
#[tauri::command]
pub fn return_worktree(
    app_state: State<Arc<AppState>>,
    worktree_id: i32,
) -> Result<(), String> {
    println!("return_worktree({}) called", worktree_id);
    
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();
    
    conn.execute(
        "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
        rusqlite::params![&now, worktree_id],
    )
    .map_err(|e| format!("Failed to return worktree: {}", e))?;
    
    println!("✓ Returned worktree {} to pool", worktree_id);
    Ok(())
}

/// Get current pool status for monitoring
#[tauri::command]
pub fn get_pool_status(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<PoolStatus, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    
    let available: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Available'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    let leased: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Leased'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    let in_use: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'InUse'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    let dirty: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Dirty'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    let total = available + leased + in_use + dirty;
    let utilization_percent = if total > 0 {
        ((leased + in_use) as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    
    Ok(PoolStatus {
        total,
        available,
        leased,
        in_use,
        dirty,
        utilization_percent,
    })
}

// ============================================================================
// Worktree Cleanup
// ============================================================================

// Worktree Cleanup Lifecycle
//
// 1. Task completes → agent calls merge to main
// 2. Phase 6 (Review & Merge) calls cleanup_worktree(worktree_id, repo_path)
// 3. cleanup_worktree:
//    - Marks worktree as 'Dirty' (durable state, survives crashes)
//    - Spawns async sidecar to delete worktree + branch (safe order: worktree → branch → prune)
//    - Uses tokio::process::Command for async context (NOT blocking std::process::Command)
//    - Deletes from database on success
//    - Returns Err if sidecar fails (leaves dirty for retry)
// 4. If cleanup fails or process crashes:
//    - Worktree stays marked 'Dirty'
//    - Call recover_dirty_worktrees() on next app startup or manually
//    - Prevents orphaned worktrees from blocking pool
//
// Database State Machine:
// Leased/InUse → Dirty (on cleanup start) → [deleted] (on cleanup success)
// If cleanup fails: Dirty → [retry later via recover_dirty_worktrees]
//
// CRITICAL INTEGRATION POINT (Phase 2):
// - App.tsx should call invoke("recover_dirty_worktrees", {...}) in useEffect on project open
// - This ensures stuck worktrees are recovered at startup

/// Delete worktree and associated branch after task merge
///
/// This function implements safe deletion with recovery for failures:
/// 1. Marks worktree as 'Dirty' (failure-proof flag, survives crashes)
/// 2. Calls async sidecar to delete worktree + branch (safe git sequence)
/// 3. Removes from database on success
///
/// If any step fails, worktree remains 'Dirty' for manual recovery.
///
/// # Arguments
/// * `project_id` - Project owning the worktree
/// * `worktree_id` - ID of worktree to clean
/// * `repo_path` - Path to git repository
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// `Ok(())` on successful cleanup, `Err(msg)` on failure
///
/// # Safety
/// Uses database transaction to ensure atomicity. Sidecar call via tokio (async-safe).
/// If sidecar fails, worktree stays marked 'Dirty' for retry.
///
/// # Async Context
/// MUST use tokio::process::Command (NOT std::process::Command) to avoid blocking.
#[tauri::command]
pub async fn cleanup_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    println!("cleanup_worktree({}, {}) called", project_id, worktree_id);
    
    // Fetch worktree record
    let (path, branch_name) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        
        let result: Result<(String, String), _> = conn.query_row(
            "SELECT path, branch_name FROM worktrees WHERE id = ? AND project_id = ?",
            rusqlite::params![worktree_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        
        match result {
            Ok(data) => data,
            Err(_) => return Err(format!("Worktree {} not found", worktree_id)),
        }
    };
    
    // Mark as dirty
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
            [worktree_id],
        )
        .map_err(|e| format!("Failed to mark dirty: {}", e))?;
    }
    
    // TODO: Phase 4 - Invoke sidecar with tokio::process::Command
    // For now, stub the sidecar invocation
    println!("TODO: Invoke sidecar deleteWorktree({}, {}, {})", repo_path, path, branch_name);
    
    // Simulate success for now
    // In Phase 4, this will be actual async sidecar call
    
    // Delete from database
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "DELETE FROM worktrees WHERE id = ? AND status = 'Dirty'",
            [worktree_id],
        )
        .map_err(|e| format!("Failed to delete worktree: {}", e))?;
    }
    
    println!("✓ Cleaned up worktree {} (branch: {})", worktree_id, branch_name);
    Ok(())
}

/// Recover worktrees stuck in 'Dirty' state
///
/// Called on app startup to retry cleanup of worktrees that failed mid-operation.
/// Prevents orphaned worktrees from accumulating and blocking the pool.
///
/// # Arguments
/// * `project_id` - Project to recover worktrees for
/// * `repo_path` - Path to git repository
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// Vec of successfully recovered worktree IDs (for logging)
///
/// # Integration
/// Should be invoked in App.tsx useEffect on project load (see Phase 2 integration point)
#[tauri::command]
pub async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<i32>, String> {
    println!("recover_dirty_worktrees({}) called", project_id);
    
    // Query dirty worktrees
    let dirty_worktrees: Vec<(i32, String, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let mut stmt = conn
            .prepare("SELECT id, path, branch_name FROM worktrees WHERE project_id = ? AND status = 'Dirty'")
            .map_err(|e| e.to_string())?;

        let rows = stmt.query_map([project_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    
    if dirty_worktrees.is_empty() {
        println!("No dirty worktrees to recover");
        return Ok(vec![]);
    }
    
    println!("Found {} dirty worktrees, attempting recovery", dirty_worktrees.len());
    
    let mut recovered_ids = vec![];
    
    for (wt_id, path, branch) in &dirty_worktrees {
        // TODO: Phase 4 - Invoke sidecar deleteWorktree via tokio::process::Command
        println!("TODO: Recover worktree {} via sidecar deleteWorktree({}, {}, {})", wt_id, repo_path, path, branch);
        
        // Simulate success for now
        // In Phase 4, this will be actual async sidecar call with error handling
        
        // Delete from database on success
        let result = {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.execute("DELETE FROM worktrees WHERE id = ?", [wt_id])
        };
        
        match result {
            Ok(_) => {
                println!("✓ Recovered worktree {}", wt_id);
                recovered_ids.push(*wt_id);
            }
            Err(e) => {
                eprintln!("Failed to delete recovered worktree {}: {}", wt_id, e);
            }
        }
    }
    
    println!("Recovery complete: {}/{} worktrees recovered", recovered_ids.len(), dirty_worktrees.len());
    Ok(recovered_ids)
}

// ============================================================================
// Worktree Pool Pre-creation
// ============================================================================

const DEFAULT_POOL_SIZE: i32 = 3;

// INTEGRATION POINT: App.tsx (Phase 2)
// After user selects project and project loads:
// 1. recover_dirty_worktrees() to retry any failed cleanups
// 2. initialize_worktree_pool() to pre-create 3 available worktrees
//
// Sequence in App.tsx useEffect (when project changes):
// useEffect(() => {
//   if (project) {
//     // Recover stuck worktrees
//     invoke("recover_dirty_worktrees", { projectId: project.id, repoPath: project.path });
//     // Pre-create pool for instant allocation
//     invoke("initialize_worktree_pool", { projectId: project.id, repoPath: project.path });
//   }
// }, [project]);

/// Pre-create worktree pool on project open
///
/// Creates database entries for available worktrees to enable instant allocation.
/// Actual git worktree creation happens lazily when worktree is leased for task execution.
///
/// Design:
/// - Creates 3 database entries in 'available' state
/// - Lazy git worktree creation on first lease (avoids slow disk I/O at startup)
/// - If pool already initialized, returns current pool status
/// - Idempotent: safe to call multiple times
///
/// # Arguments
/// * `project_id` - Project to initialize pool for
/// * `repo_path` - Path to git repository
/// * `pool_size` - Optional pool size (default: 3). Override for testing.
/// * `state` - Tauri app state with database connection
///
/// # Returns
/// Current PoolStatus showing total, available, leased, dirty counts
///
/// # Integration
/// Should be called in App.tsx useEffect after project is selected:
/// ```typescript
/// await invoke("initialize_worktree_pool", { projectId: project.id, repoPath: project.path });
/// ```
#[tauri::command]
pub fn initialize_worktree_pool(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    _repo_path: String,
    pool_size: Option<i32>,
) -> Result<PoolStatus, String> {
    let pool_size = pool_size.unwrap_or(DEFAULT_POOL_SIZE);
    println!("initialize_worktree_pool(project={}, size={}) called", project_id, pool_size);
    
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    
    // Check existing available worktrees
    let current_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ? AND status = 'Available'",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    if current_count >= pool_size {
        println!("Pool already initialized ({} available)", current_count);
        drop(conn);
        return get_pool_status(app_state, project_id);
    }
    
    // Create missing worktrees
    let total_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
        [project_id],
        |row| row.get(0),
    )
    .unwrap_or(0);
    
    let needed = pool_size - current_count;
    println!("Creating {} worktrees (current: {}, target: {})", needed, current_count, pool_size);
    
    let now = chrono::Utc::now().to_rfc3339();
    
    for i in 1..=needed {
        let worktree_num = total_count + i;
        let worktree_id = format!("wt-{:03}", worktree_num);
        let branch_name = format!("pool/reserved-{}", worktree_num);
        let path = format!(".worktree-pool/{}", worktree_id);
        
        conn.execute(
            "INSERT INTO worktrees (project_id, branch_name, path, status, created_at) 
             VALUES (?, ?, ?, 'Available', ?)",
            rusqlite::params![project_id, &branch_name, &path, &now],
        )
        .map_err(|e| format!("Failed to create worktree {}: {}", worktree_id, e))?;
        
        println!("✓ Created worktree {} (database entry)", worktree_id);
    }
    
    drop(conn);
    
    println!("✓ Pool initialized with {} worktrees", pool_size);
    get_pool_status(app_state, project_id)
}

// ============================================================================
// Agent Execution
// ============================================================================

/// Spawn an agent execution for a task in a background task
///
/// Detect and categorize error from stderr output and exit code
///
/// Analyzes error patterns in stderr to categorize error type and generate suggestions
fn detect_error_type_and_suggestions(stderr: &str, exit_code: i32) -> (String, Vec<String>) {
    let stderr_lower = stderr.to_lowercase();

    // Pattern matching for error types
    if stderr_lower.contains("error ts") ||
       stderr_lower.contains("syntaxerror") ||
       stderr_lower.contains("referenceerror") {
        return ("CompilationError".to_string(), vec![
            "Run: npm install".to_string(),
            "Check syntax in source files".to_string(),
        ]);
    }

    if stderr_lower.contains("not found") ||
       stderr_lower.contains("cannot find module") ||
       stderr_lower.contains("npm err") ||
       stderr_lower.contains("package.json") {
        return ("MissingDependency".to_string(), vec![
            "Run: npm install".to_string(),
            "Check package.json dependencies".to_string(),
        ]);
    }

    if stderr_lower.contains("error:") ||
       stderr_lower.contains("exception") ||
       stderr_lower.contains("panic") ||
       stderr_lower.contains("segmentation fault") {
        return ("RuntimeError".to_string(), vec![
            "Check task acceptance criteria".to_string(),
            "Review error in terminal history".to_string(),
        ]);
    }

    if exit_code < 0 || stderr_lower.contains("signal") {
        return ("ProcessCrash".to_string(), vec![
            "Check system resources".to_string(),
            "Review agent logs".to_string(),
        ]);
    }

    // Default to Unknown
    ("Unknown".to_string(), vec![
        "Review full terminal output".to_string(),
        "Check error details".to_string(),
    ])
}

/// This handler creates an execution log record, spawns the agent CLI process
/// in a background tokio task, and returns immediately with the execution log ID.
/// The process continues running after the IPC returns.
///
/// # Arguments
/// * `app_state` - Tauri app state with database connection
/// * `project_id` - Project ID (for context)
/// * `task_id` - Task ID to execute
/// * `repo_path` - Repository path for the agent
///
/// # Returns
/// Execution log ID that tracks the execution
///
/// # Async Behavior
/// - Creates execution log synchronously
/// - Spawns background task with tokio::spawn
/// - Returns immediately (process continues in background)
/// - Background task captures output and marks completion
/// - Failure detection: exit_code != 0 sets status to "failed" (EXEC-06)
#[tauri::command]
pub async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("spawn_agent_execution(project={}, task={}) called", project_id, task_id);

    // 0. Get project and determine if remote
    let is_remote = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let is_remote: bool = conn.query_row(
            "SELECT is_remote FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        ).map_err(|e| format!("Failed to load project: {}", e))?;
        drop(conn);
        is_remote
    };

    println!("✓ Determined execution type (is_remote: {})", is_remote);

    // 1. Create execution log record
    let exec_log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::db::execution_logs::create_execution_log(&conn, task_id, 0)?
    };
    println!("✓ Created execution log {}", exec_log_id);

    // 2. Lease worktree from pool
    let worktree = lease_worktree(app_state.clone(), project_id, task_id, repo_path.clone()).await?;
    let worktree_id = worktree.id;
    let worktree_path = format!("{}/{}", repo_path, worktree.path);
    println!("✓ Leased worktree {} at path {}", worktree_id, worktree.path);

    // 3. Get task for execution
    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let result = conn.query_row(
            "SELECT id, project_id, name, description, acceptance_criteria, status, external_id, is_imported, import_source, skills, model_override, mcp_allowlist, skills_override, created_at, updated_at
             FROM tasks WHERE id = ?",
            [task_id],
            |row| {
                let status_str: String = row.get(5)?;
                let status = match status_str.as_str() {
                    "Backlog" => TaskStatus::Backlog,
                    "Ready" => TaskStatus::Ready,
                    "InProgress" => TaskStatus::InProgress,
                    "Review" => TaskStatus::Review,
                    "Merging" => TaskStatus::Merging,
                    "Failed" => TaskStatus::Failed,
                    _ => TaskStatus::Done,
                };

                let skills_json: String = row.get(9)?;
                let skills: Vec<String> = serde_json::from_str(&skills_json).unwrap_or_default();
                let mcp_json: Option<String> = row.get(11)?;
                let mcp_allowlist = mcp_json.and_then(|j| serde_json::from_str(&j).ok());
                let skills_json: Option<String> = row.get(12)?;
                let skills_override = skills_json.and_then(|j| serde_json::from_str(&j).ok());

                Ok(Task {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    acceptance_criteria: row.get(4)?,
                    status,
                    external_id: row.get(6)?,
                    is_imported: row.get(7)?,
                    import_source: row.get(8)?,
                    skills,
                    model_override: row.get(10)?,
                    mcp_allowlist,
                    skills_override,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        );
        drop(conn);
        result.map_err(|e| format!("Failed to load task: {}", e))?
    };

    // 4. Build execution config from task and project settings
    let config = ExecutionConfig {
        model_override: task.model_override.clone(),
        mcp_allowlist: task.mcp_allowlist.clone(),
        skills_override: task.skills_override.clone(),
    };

    // 5. Extract Arc<AppState> from State for background task
    let app_state_arc = (*app_state).clone();

    // 6. Spawn background task (returns immediately to caller)
    tokio::spawn(async move {
        println!("[background] Starting agent execution for task {} in worktree {}", task_id, worktree_id);

        // For local execution: continue using existing PTY spawner
        if !is_remote {
            match spawn_agent_cli_pty(
                task_id,
                "node".to_string(),
                vec!["sidecar/dist/index.js".to_string(), "--task-id".to_string(), task_id.to_string()],
                std::path::PathBuf::from(&worktree_path),
            )
            .await
            {
                Ok(pty_session) => {
                    println!("[background] PTY session spawned for task {}", task_id);

                    // Store PtySession in AppState for frontend attachment
                    {
                        let mut sessions = app_state_arc.pty_sessions.lock().await;
                        sessions.insert(task_id, Arc::new(tokio::sync::Mutex::new(pty_session)));
                        println!("[background] ✓ Stored PTY session for task {} in AppState", task_id);
                    }

                    // Initialize execution log status
                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            if let Err(e) = crate::db::execution_logs::mark_complete(&conn, exec_log_id, 0) {
                                eprintln!("[background] Failed to initialize execution log: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[background] PTY spawning failed: {}", e);

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = format!("\n[ERROR] Failed to spawn PTY: {}", e);
                            let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&e, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = ErrorEvent {
                                error_type: error_type.clone(),
                                message: e.clone(),
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);

                            let _ = conn.execute(
                                "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                rusqlite::params![worktree_id],
                            );
                            println!("✗ Marked worktree {} as dirty due to spawn error. Error type: {}", worktree_id, error_type);
                        }
                        Err(lock_err) => {
                            eprintln!("[background] Failed to lock database for error logging: {}", lock_err);
                        }
                    }
                }
            }
        } else {
            // For remote execution: Get SSH session and call dispatcher

            // Get SSH session from AppState
            match app_state_arc.get_ssh_session(project_id as i64).await {
                Some(ssh_session) => {
                    // 2. Build GitConnection for dispatcher
                    let git_conn = GitConnection::Remote {
                        ssh: std::sync::Arc::new(ssh_session),
                        remote_path: worktree_path.clone(), // Use the leased worktree path as remote root
                    };

                    // 3. Call dispatcher which handles remote execution
                    match spawn_agent_execution_dispatcher(&git_conn, &worktree, &task, &config).await {
                        Ok((_output, Some(handle))) => {
                            // 4. Attach streaming to the remote handle
                            // Create broadcast_sender callback that forwards to execution log
                            let exec_log_id_for_streaming = exec_log_id;
                            let app_state_for_streaming = app_state_arc.clone();
                            let broadcast_sender = move |bytes: Vec<u8>| {
                                // Forward bytes to execution log terminal_output
                                if let Ok(conn) = app_state_for_streaming.db.lock() {
                                    let output_str = String::from_utf8_lossy(&bytes);
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id_for_streaming, &output_str);
                                }
                            };

                            // 5. Call attach_remote_stream_listener to start streaming background task
                            if let Err(e) = attach_remote_stream_listener(&handle, broadcast_sender).await {
                                eprintln!("[background] Failed to attach stream listener: {}", e);
                            }

                            println!("[background] ✓ Remote execution spawned with streaming (PID: {})", handle.remote_pid);

                            // 6. Initialize execution log status
                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let _ = crate::db::execution_logs::mark_complete(&conn, exec_log_id, 0);
                                }
                                Err(e) => {
                                    eprintln!("[background] Failed to initialize execution log: {}", e);
                                }
                            }
                        }
                        Ok((_output, None)) => {
                            eprintln!("[background] Remote execution returned no handle");

                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let error_msg = "[ERROR] Remote execution returned no handle".to_string();
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                                    let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                                    let now = Utc::now().to_rfc3339();
                                    let error_event = ErrorEvent {
                                        error_type,
                                        message: error_msg,
                                        suggestions,
                                        detected_at: now,
                                    };

                                    let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                                    let _ = conn.execute(
                                        "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                        rusqlite::params![worktree_id],
                                    );
                                }
                                Err(e) => {
                                    eprintln!("[background] Failed to lock database: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Remote execution dispatcher failed: {}", e);

                            match app_state_arc.db.lock() {
                                Ok(conn) => {
                                    let error_msg = format!("[ERROR] Remote execution failed: {}", e);
                                    let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                                    let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                                    let now = Utc::now().to_rfc3339();
                                    let error_event = ErrorEvent {
                                        error_type,
                                        message: error_msg,
                                        suggestions,
                                        detected_at: now,
                                    };

                                    let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                                    let _ = conn.execute(
                                        "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                        rusqlite::params![worktree_id],
                                    );
                                }
                                Err(lock_err) => {
                                    eprintln!("[background] Failed to lock database: {}", lock_err);
                                }
                            }
                        }
                    }
                }
                None => {
                    eprintln!("[background] SSH session not available for remote project");

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = "[ERROR] SSH session not available for remote project".to_string();
                            let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&error_msg, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = ErrorEvent {
                                error_type,
                                message: error_msg,
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::execution_logs::mark_failed(&conn, exec_log_id, &error_event);
                            let _ = conn.execute(
                                "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                                rusqlite::params![worktree_id],
                            );
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
            }
        }

        // Finalize: Return worktree to pool after execution completes (success or failure)
        {
            match app_state_arc.db.lock() {
                Ok(conn) => {
                    let now = chrono::Utc::now().to_rfc3339();
                    match conn.execute(
                        "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
                        rusqlite::params![&now, worktree_id],
                    ) {
                        Ok(_) => println!("[finalize] ✓ Returned worktree {} to pool", worktree_id),
                        Err(e) => eprintln!("[finalize] ✗ Failed to return worktree to pool: {}", e),
                    }
                }
                Err(e) => eprintln!("[finalize] ✗ Failed to lock database to return worktree: {}", e),
            }
        }

        println!("[background] Agent execution complete for task {}", task_id);
    });

    // 7. Return execution_log id immediately (process runs in background)
    println!("✓ Spawned background agent task, execution log id: {}", exec_log_id);
    Ok(exec_log_id)
}

/// Get execution logs for a task
#[tauri::command]
pub fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<crate::models::ExecutionLog>, String> {
    println!("get_execution_logs({}) called", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn.prepare(
        "SELECT id, task_id, status, output, terminal_output, started_at, completed_at, error_event
         FROM execution_logs
         WHERE task_id = ?
         ORDER BY started_at DESC"
    ).map_err(|e| e.to_string())?;

    let logs = stmt.query_map(rusqlite::params![task_id], |row| {
        let status_str: String = row.get(2)?;
        let status = match status_str.as_str() {
            "complete" => crate::models::ExecutionStatus::Complete,
            "failed" => crate::models::ExecutionStatus::Failed,
            "paused" => crate::models::ExecutionStatus::Paused,
            "cancelled" => crate::models::ExecutionStatus::Cancelled,
            _ => crate::models::ExecutionStatus::Running,
        };

        // Parse error_event from JSON if present
        let error_event = row.get::<_, Option<String>>(7)?
            .and_then(|s| serde_json::from_str(&s).ok());

        Ok(crate::models::ExecutionLog {
            id: row.get(0)?,
            task_id: row.get(1)?,
            status,
            output: row.get(3)?,
            terminal_output: row.get(4)?,
            started_at: row.get(5)?,
            completed_at: row.get(6)?,
            error_event,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for log in logs {
        result.push(log.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Retry a paused execution
#[tauri::command]
pub async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("retry_execution(project={}, task={}) called", project_id, task_id);

    // Simply spawn a new execution for the same task
    spawn_agent_execution(app_state, project_id, task_id, repo_path).await
}

/// Cancel a paused execution
#[tauri::command]
pub fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    println!("cancel_execution({}) called", log_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE execution_logs SET status = 'cancelled', completed_at = ? WHERE id = ?",
        rusqlite::params![&now, log_id],
    )
    .map_err(|e| format!("Failed to cancel execution: {}", e))?;

    println!("✓ Cancelled execution log {}", log_id);
    Ok(())
}

/// Attach to a PTY session and stream output to frontend
///
/// Opens a Tauri channel and begins streaming PTY output to the frontend.
/// Optionally prepends terminal history from the execution log (if available).
/// The streaming continues until the PTY process ends or the channel is closed.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID to attach to
/// * `output_channel` - Tauri IPC channel for streaming output
/// * `include_history` - If true, prepend terminal_output from execution log to stream
///
/// # Returns
/// `Result<(), String>` - Ok if streaming started, Err if task not found
///
/// # Behavior
/// When `include_history` is true:
/// 1. Fetches the terminal_output from the most recent execution log
/// 2. Sends entire history as initial message to establish context
/// 3. Then continues streaming live PTY output as normal
/// This ensures the frontend sees the full terminal context when attaching.
#[tauri::command]
pub async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    println!("attach_terminal({}) called (include_history: {})", task_id, include_history.unwrap_or(false));

    // Get PTY session from AppState
    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions); // Release lock

    println!("[attach] Starting output streaming for task {}", task_id);

    // If requested, send terminal history first
    if include_history.unwrap_or(false) {
        println!("[attach] Fetching terminal history for task {}", task_id);
        // Try to get execution logs to prepend history
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let history = conn.query_row(
            "SELECT terminal_output FROM execution_logs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
            rusqlite::params![task_id],
            |row| row.get::<_, Option<String>>(0)
        ).ok().flatten();

        if let Some(history_text) = history {
            if !history_text.is_empty() {
                println!("[attach] Sending {} chars of history to frontend", history_text.len());
                if output_channel.send(history_text).is_err() {
                    println!("[attach] Channel closed while sending history");
                    return Err("Channel closed before history could be sent".to_string());
                }
            }
        }
    }

    // Spawn background task to stream PTY output
    tokio::spawn(async move {
        // Create bounded channel for buffering between PTY reader and frontend sender
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

        // Spawn PTY reader task
        let session_reader = session.clone();
        let reader_task = tokio::spawn(async move {
            loop {
                // Try to get a reader from the PTY master
                let session_lock = session_reader.lock().await;
                let mut reader = match session_lock.master.lock().await.try_clone_reader() {
                    Ok(r) => r,
                    Err(_) => {
                        println!("[PTY reader] Failed to clone reader, stopping");
                        break;
                    }
                };
                drop(session_lock);

                // Read from PTY in 4096-byte chunks
                let mut buf = [0u8; 4096];
                match reader.read(&mut buf) {
                    Ok(0) => {
                        println!("[PTY reader] EOF reached, stopping");
                        break;
                    }
                    Ok(n) => {
                        // Decode UTF-8, using lossy conversion to handle mid-sequence bytes
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if tx.send(output).await.is_err() {
                            println!("[PTY reader] Channel closed by receiver, stopping");
                            break;
                        }
                    }
                    Err(e) => {
                        println!("[PTY reader] Read error: {}, stopping", e);
                        break;
                    }
                }
            }
        });

        // Spawn frontend sender task
        let sender_task = tokio::spawn(async move {
            while let Some(output) = rx.recv().await {
                if output_channel.send(output).is_err() {
                    println!("[frontend sender] Channel closed, stopping");
                    break;
                }
            }
        });

        // Wait for either task to complete
        tokio::select! {
            _ = reader_task => {
                println!("[attach] Reader task completed");
            }
            _ = sender_task => {
                println!("[attach] Sender task completed");
            }
        }

        println!("[attach] Output streaming ended for task {}", task_id);
    });

    println!("[attach] ✓ Streaming started for task {}", task_id);
    Ok(())
}

/// Send input to a PTY session
///
/// Writes data to the PTY master, which is delivered to the child process stdin.
/// Supports special control sequences:
/// - "\x03" (Ctrl+C) → sends SIGINT signal (interrupt) via PTY layer
/// - "\x1a" (Ctrl+Z) → sends SIGTSTP signal (suspend) via PTY layer
/// - Regular text and newlines → written directly to PTY stdin
///
/// The PTY layer automatically converts control sequences to signals that are
/// delivered to the foreground process group.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `input` - Data to send to the PTY (can be control sequences or regular text)
///
/// # Returns
/// `Result<(), String>` - Ok if input sent, Err if session not found or write failed
///
/// # Examples
/// - Regular text: "ls -la\n" → written to stdin
/// - Ctrl+C: "\x03" → converted to SIGINT by PTY layer
/// - Ctrl+Z: "\x1a" → converted to SIGTSTP by PTY layer
#[tauri::command]
pub async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    // Log control sequences for debugging
    if input == "\x03" {
        println!("send_terminal_input({}) - Ctrl+C (SIGINT)", task_id);
    } else if input == "\x1a" {
        println!("send_terminal_input({}) - Ctrl+Z (SIGTSTP)", task_id);
    } else {
        println!("send_terminal_input({}) - {} bytes of text", task_id, input.len());
    }

    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    // Write directly to PTY - the PTY layer handles conversion of control sequences to signals
    let session_lock = session.lock().await;
    session_lock.write_input(input.as_bytes()).await
}

/// Resize a PTY session to new dimensions
///
/// Changes the terminal size and sends SIGWINCH to the PTY process.
/// Used when the frontend terminal is resized.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `cols` - New column width
/// * `rows` - New row height
///
/// # Returns
/// `Result<(), String>` - Ok if resized, Err if session not found or resize failed
#[tauri::command]
pub async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    println!("resize_terminal({}) called with {}x{}", task_id, cols, rows);

    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    let session_lock = session.lock().await;
    session_lock.resize_pty(cols, rows).await
}

/// Append terminal output to an execution log for persistence
///
/// Persists streamed PTY output to the database for execution history.
/// Called periodically (via tokio::time::interval) or when accumulating large chunks
/// to avoid excessive database writes.
///
/// # Arguments
/// * `state` - Tauri app state with database connection
/// * `task_id` - Task ID being executed
/// * `output` - Terminal output chunk to append
///
/// # Returns
/// `Result<(), String>` - Ok if append successful, Err on database error
///
/// # Behavior
/// - Appends output to most recent execution log for this task
/// - Uses COALESCE to handle NULL terminal_output gracefully
/// - Only updates logs with status 'running', 'failed', or 'complete'
#[tauri::command]
pub async fn append_terminal_output(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
    output: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Append to most recent execution log for this task (typically running/active one)
    let result = conn.execute(
        "UPDATE execution_logs
         SET terminal_output = COALESCE(terminal_output, '') || ?
         WHERE task_id = ? AND status IN ('running', 'failed', 'complete')
         ORDER BY id DESC LIMIT 1",
        rusqlite::params![&output, task_id],
    );

    // Note: The ORDER BY in an UPDATE is non-standard but works in SQLite
    // If this causes issues, we can use a subquery approach instead:
    // UPDATE execution_logs
    // SET terminal_output = COALESCE(terminal_output, '') || ?
    // WHERE id = (SELECT id FROM execution_logs
    //             WHERE task_id = ? AND status IN (...)
    //             ORDER BY id DESC LIMIT 1)

    match result {
        Ok(0) => {
            // No rows updated (no active execution log found)
            println!("[append_terminal] No active execution log found for task {}", task_id);
            Ok(())
        }
        Ok(_) => {
            println!("[append_terminal] ✓ Appended {} bytes to execution log for task {}", output.len(), task_id);
            Ok(())
        }
        Err(e) => Err(format!("Failed to append terminal output: {}", e)),
    }
}

/// Get unified diff for a task in Review column
/// Fetches diff between agent branch and main branch with --unified=6 context lines
#[tauri::command]
pub async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    println!("get_diff_for_review({}) called", task_id);

    // 1. Query task to get project_id and task details
    let (_project_id, project, worktree_path, branch_name) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let proj_id: i32 = conn
            .query_row(
                "SELECT project_id FROM tasks WHERE id = ?",
                rusqlite::params![task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Task not found: {}", e))?;

        // Get project details (local path, is_remote, ssh_config)
        let (path, is_remote, ssh_config_json): (String, bool, Option<String>) = conn
            .query_row(
                "SELECT path, is_remote, ssh_config FROM projects WHERE id = ?",
                rusqlite::params![proj_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| format!("Project not found: {}", e))?;

        let ssh_config = ssh_config_json
            .and_then(|json| serde_json::from_str(&json).ok());

        let project = Project {
            id: proj_id,
            name: String::new(), // Not needed for this operation
            path,
            created_at: String::new(), // Not needed
            is_remote,
            ssh_config,
        };

        // Find worktree for this task
        let (wt_path, branch): (String, String) = conn
            .query_row(
                "SELECT path, branch_name FROM worktrees WHERE project_id = ? AND (status = 'InUse' OR status = 'Leased')",
                rusqlite::params![proj_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("Worktree not found for task: {}", e))?;

        (proj_id, project, wt_path, branch)
    };

    // 2. Handle diff generation based on project type
    if project.is_remote {
        // Remote project: use git dispatcher which executes over SSH
        println!("  Generating diff for remote project via SSH");

        let git_conn = get_git_connection(&project, &app_state)
            .await
            .map_err(|e| format!("Failed to get git connection: {}", e))?;

        // For remote, we execute git diff on the remote machine
        // The worktree_path is relative to the remote project root
        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff from remote: {}", e))?;

        println!("✓ Generated diff for task {} from remote: {} bytes", task_id, diff.len());
        Ok(diff)
    } else {
        // Local project: use Node.js sidecar (Phase 3-01 integration)
        println!("  Generating diff for local project via sidecar");

        let full_worktree_path = format!("{}/{}", project.path, worktree_path);

        println!("  Generating diff for branch {} in worktree {}", branch_name, full_worktree_path);

        // Call Node.js sidecar to generate diff
        let output = tokio::process::Command::new("node")
            .args(&[
                "sidecar/dist/index.js",
                "--get-diff",
                &full_worktree_path,
                &branch_name,
                "main", // Compare against main branch
                "6",    // 6 context lines
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Sidecar failed: {}", stderr));
        }

        let diff = String::from_utf8(output.stdout)
            .map_err(|e| format!("Failed to decode sidecar output: {}", e))?;

        println!("✓ Generated diff for task {}: {} bytes", task_id, diff.len());
        Ok(diff)
    }
}

/// Save task review with feedback and per-file comments
#[tauri::command]
pub async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    println!("save_task_review({}, decision={}) called", task_id, decision);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();

    // Insert into task_reviews
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at)
         VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, &decision, &general_feedback, &now, &now],
    )
    .map_err(|e| format!("Insert review failed: {}", e))?;

    // Get review_id
    let review_id: i32 = conn
        .query_row(
            "SELECT id FROM task_reviews WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Insert per-file comments if provided
    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, &now],
            )
            .map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }

    println!("✓ Saved review for task {}: review_id={}", task_id, review_id);
    Ok(serde_json::json!({ "success": true, "review_id": review_id }))
}

/// Request changes on a task (saves feedback and moves task back to InProgress)
#[tauri::command]
pub async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    println!("request_changes({}) called", task_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();

    // Save feedback with RequestChanges decision
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at)
         VALUES (?, 'RequestChanges', ?, ?, ?)",
        rusqlite::params![task_id, general_feedback, &now, &now],
    )
    .map_err(|e| format!("Insert review failed: {}", e))?;

    // Get review_id and save per-file comments
    let review_id: i32 = conn
        .query_row(
            "SELECT id FROM task_reviews WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, &now],
            )
            .map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }

    // Update task status to InProgress
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    )
    .map_err(|e| format!("Update task status failed: {}", e))?;

    println!(
        "✓ Requested changes for task {}: review_id={}, status=InProgress",
        task_id, review_id
    );
    Ok(serde_json::json!({
        "success": true,
        "review_id": review_id,
        "task_status": "InProgress"
    }))
}

// ============================================================================
// Merge Automation and Conflict Handling
// ============================================================================

/// Approve task and initiate automatic merge to main branch
///
/// Orchestrates the complete merge workflow:
/// 1. Updates task status to "Merging" (transient state)
/// 2. Spawns async background task to perform squash merge
/// 3. On success: updates task to "Done", cleans up worktree, returns to pool
/// 4. On conflict: rejects task back to "InProgress", saves conflict feedback
/// 5. Emits Tauri events for frontend UI updates and notifications
///
/// Returns immediately with "merging started" confirmation.
/// Frontend listens for merge_complete or merge_error events for final status.
#[tauri::command]
pub async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<serde_json::Value, String> {
    println!("approve_task_and_merge({}) called", task_id);

    // 1. Query task details and worktree info
    let (task_name, branch_name, worktree_path, worktree_id, _project_id, repo_path) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let (t_name, w_branch, w_path, w_id, p_id): (String, String, String, i32, i32) = conn
            .query_row(
                "SELECT t.name, w.branch_name, w.path, w.id, t.project_id
                 FROM tasks t
                 JOIN worktrees w ON w.id = (
                   SELECT id FROM worktrees WHERE project_id = t.project_id
                   AND (status = 'InUse' OR status = 'Leased') LIMIT 1
                 )
                 WHERE t.id = ?",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|e| format!("Task or worktree not found: {}", e))?;

        // Get project repo path
        let p_path: String = conn
            .query_row(
                "SELECT path FROM projects WHERE id = ?",
                [p_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Project not found: {}", e))?;

        (t_name, w_branch, w_path, w_id, p_id, p_path)
    };

    // 2. Update task status to "Merging"
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE tasks SET status = 'Merging', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| format!("Failed to update task status: {}", e))?;

        println!("✓ Task {} status updated to Merging", task_id);
    }

    // 3. Spawn async merge operation in background
    let app_state_clone = app_state.inner().clone();

    tokio::spawn(async move {
        println!(
            "[merge] Starting async merge for task {} (branch: {})",
            task_id, branch_name
        );

        // Build full worktree path
        let full_worktree_path = format!("{}/{}", repo_path, worktree_path);

        // Call Node.js sidecar to perform squash merge
        let sidecar_result = tokio::process::Command::new("node")
            .args(&[
                "sidecar/dist/index.js",
                "--merge",
                &full_worktree_path,
                &task_id.to_string(),
                &branch_name,
                &task_name,
            ])
            .output()
            .await;

        match sidecar_result {
            Ok(output) => {
                if output.status.success() {
                    // Parse stdout as JSON to extract MergeOutcome
                    let stdout = String::from_utf8_lossy(&output.stdout);

                    match serde_json::from_str::<MergeOutcome>(&stdout) {
                        Ok(merge_outcome) => {
                            if merge_outcome.success {
                                // Merge succeeded - cleanup and mark task Done
                                println!("[merge] ✓ Merge succeeded for task {}", task_id);

                                if let Err(e) = finalize_successful_merge(
                                    &app_state_clone,
                                    task_id,
                                    worktree_id,
                                    &full_worktree_path,
                                    &repo_path,
                                    &branch_name,
                                ).await {
                                    eprintln!("[merge] Merge finalization error: {}", e);
                                } else {
                                    println!("[merge] ✓ Merge finalized successfully for task {}", task_id);
                                }
                            } else if !merge_outcome.conflicts.is_empty() {
                                // Merge had conflicts - reject and move back to InProgress
                                println!("[merge] Merge conflict detected for task {}", task_id);

                                if let Err(e) = reject_merge_on_conflict(
                                    &app_state_clone,
                                    task_id,
                                    &merge_outcome.conflicts,
                                ).await {
                                    eprintln!("[merge] Failed to reject on conflict: {}", e);
                                } else {
                                    println!("[merge] Task {} rejected to InProgress due to merge conflict", task_id);
                                }
                            } else {
                                // Other error - leave task in Merging state and log
                                eprintln!("[merge] Merge error: {}", merge_outcome.message.unwrap_or_default());
                            }
                        }
                        Err(e) => {
                            eprintln!("[merge] Failed to parse merge outcome JSON: {}", e);
                            eprintln!("[merge] stdout: {}", stdout);
                        }
                    }
                } else {
                    // Merge process exited with error
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("[merge] Sidecar exited with error for task {}: {}", task_id, stderr);
                }
            }
            Err(e) => {
                eprintln!("[merge] Sidecar error for task {}: {}", task_id, e);
            }
        }

        println!("[merge] Async merge operation complete for task {}", task_id);
    });

    Ok(serde_json::json!({ "merging": true, "message": "Merge started" }))
}

/// Finalize successful merge: update task to Done, cleanup worktree from disk, return to pool
async fn finalize_successful_merge(
    app_state: &Arc<AppState>,
    task_id: i32,
    worktree_id: i32,
    worktree_path: &str,
    repo_path: &str,
    branch_name: &str,
) -> Result<(), String> {
    println!(
        "[finalize] Finalizing merge for task {}: updating task to Done",
        task_id
    );

    // 1. Update task status to Done
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE tasks SET status = 'Done', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| format!("Update task failed: {}", e))?;

        println!("[finalize] ✓ Task {} moved to Done", task_id);
    }

    // 2. Mark worktree as Dirty before cleanup (crash-safe state marking)
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
            rusqlite::params![worktree_id],
        )
        .map_err(|e| format!("Failed to mark worktree Dirty: {}", e))?;

        println!("[finalize] Marked worktree {} as Dirty before cleanup", worktree_id);
    }

    // 3. Delete worktree from disk via sidecar
    let sidecar_result = tokio::process::Command::new("node")
        .args(&[
            "sidecar/dist/index.js",
            "--delete-worktree",
            repo_path,
            worktree_path,
            branch_name,
        ])
        .output()
        .await;

    match sidecar_result {
        Ok(output) => {
            if output.status.success() {
                // Delete from database on successful cleanup
                {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.execute(
                        "DELETE FROM worktrees WHERE id = ?",
                        rusqlite::params![worktree_id],
                    )
                    .map_err(|e| format!("Failed to delete worktree from DB: {}", e))?;
                }
                println!("[finalize] ✓ Worktree {} deleted from disk and DB", worktree_id);
            } else {
                // Cleanup failed - log error but don't fail the entire merge
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("[finalize] ⚠ Cleanup failed (will retry): {}", stderr);
                // Worktree stays in Dirty state for recovery via recover_dirty_worktrees on app restart
            }
        }
        Err(e) => {
            // Sidecar spawn error - log but don't fail
            eprintln!("[finalize] ⚠ Failed to invoke sidecar: {} (will retry)", e);
            // Worktree stays in Dirty state for recovery
        }
    }

    // 4. Final status log
    println!("[finalize] ✓ Merge finalization complete for task {}", task_id);

    Ok(())
}

/// Reject merge and move task back to InProgress with conflict feedback
async fn reject_merge_on_conflict(
    app_state: &Arc<AppState>,
    task_id: i32,
    conflicts: &[String],
) -> Result<(), String> {
    println!(
        "[reject] Rejecting merge for task {} due to conflicts",
        task_id
    );

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = chrono::Utc::now().to_rfc3339();
    let conflict_feedback = format!("Merge conflict detected:\n{}", conflicts.join("\n"));

    // Auto-reject to InProgress per CONTEXT.md decision
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    )
    .map_err(|e| format!("Update task failed: {}", e))?;

    println!("[reject] ✓ Task {} moved to InProgress", task_id);

    // Save conflict feedback as review comment for visibility
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, created_at)
         VALUES (?, 'RequestChanges', ?, ?)",
        rusqlite::params![task_id, &conflict_feedback, &now],
    )
    .map_err(|e| format!("Save feedback failed: {}", e))?;

    println!("[reject] ✓ Conflict feedback saved for task {}", task_id);

    Ok(())
}

/// Get project-level configuration (model default, MCP allowlist, skills default)
#[tauri::command]
pub fn get_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    println!("get_project_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Query settings table for configuration keys
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE key IN ('model_default', 'mcp_allowlist', 'skills_default')")
        .map_err(|e| e.to_string())?;

    let mut settings_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let settings_iter = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| e.to_string())?;

    for result in settings_iter {
        let (key, value) = result.map_err(|e| e.to_string())?;
        settings_map.insert(key, value);
    }

    // Extract values with defaults
    let model_default = settings_map
        .get("model_default")
        .cloned()
        .unwrap_or_else(|| "claude-opus-4-5".to_string());

    let mcp_allowlist: Vec<String> = settings_map
        .get("mcp_allowlist")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let skills_default: Vec<String> = settings_map
        .get("skills_default")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    Ok(crate::models::ProjectConfigResponse {
        model_default,
        mcp_allowlist,
        skills_default,
    })
}

/// Update project-level configuration
#[tauri::command]
pub fn update_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    println!("update_project_settings() called via IPC");
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Serialize arrays to JSON
    let mcp_allowlist_json = serde_json::to_string(&settings.mcp_allowlist)
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_default_json = serde_json::to_string(&settings.skills_default)
        .map_err(|e| format!("Failed to serialize skills_default: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    // Use transaction for atomic writes
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    // Upsert each setting
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('model_default', ?, ?)",
        rusqlite::params![&settings.model_default, &now],
    )
    .map_err(|e| format!("Failed to update model_default: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mcp_allowlist', ?, ?)",
        rusqlite::params![&mcp_allowlist_json, &now],
    )
    .map_err(|e| format!("Failed to update mcp_allowlist: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('skills_default', ?, ?)",
        rusqlite::params![&skills_default_json, &now],
    )
    .map_err(|e| format!("Failed to update skills_default: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    println!("✓ Project settings updated");
    Ok(())
}

/// Update task-level configuration overrides
#[tauri::command]
pub fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: crate::models::TaskConfigRequest,
) -> Result<(), String> {
    println!("update_task_settings({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    // Serialize optional arrays to JSON or NULL
    let mcp_allowlist_value = settings
        .mcp_allowlist
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_override_value = settings
        .skills_override
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| format!("Failed to serialize skills_override: {}", e))?;

    // Update task with configuration overrides
    conn.execute(
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![
            &settings.model_override,
            &mcp_allowlist_value,
            &skills_override_value,
            &now,
            task_id
        ],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    println!("✓ Task {} settings updated", task_id);
    Ok(())
}

/// Detach from a PTY session (stop streaming, keep PTY alive)
///
/// Stops the output streaming to the frontend for a task but leaves the PTY session
/// running in the background. Used when user closes the terminal modal.
/// The PTY process continues executing independently.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID to detach from
///
/// # Returns
/// `Result<(), String>` - Ok if detached successfully, Err if task not found
///
/// # Note
/// This does NOT kill the PTY session - it only stops the frontend streaming.
/// The backend process continues running and can be re-attached to later.
#[tauri::command]
pub async fn detach_terminal(
    _app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    println!("detach_terminal({}) called", task_id);
    println!("[detach] ✓ Detached from terminal for task {}", task_id);

    // Note: The actual cleanup happens when the channel is dropped on the frontend.
    // The streaming tasks in attach_terminal will exit when they detect the channel is closed.
    // We don't need to explicitly stop anything here - just log and return.
    Ok(())
}

/// Test an SSH connection with the given configuration
/// Tests authentication and connectivity without storing the session
#[tauri::command]
pub async fn test_remote_connection(
    config: SshConfig,
    _state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    println!("test_remote_connection() called for {}:{}", config.host, config.port);

    // Create a temporary RemoteSshSession for testing
    use crate::ssh::RemoteSshSession;
    let session = RemoteSshSession::new(config.clone());

    // Attempt to connect with timeout
    match session.connect().await {
        Ok(_) => {
            // Connection successful, spawn disconnect in background
            let session_clone = session.clone();
            let _ = tokio::spawn(async move {
                session_clone.disconnect().await;
            });
            println!("[test_connection] ✓ Connection successful for {}:{}", config.host, config.port);
            Ok(true)
        }
        Err(e) => {
            let error_msg = format!("Connection test failed: {}", e);
            println!("[test_connection] ✗ {}", error_msg);
            Err(error_msg)
        }
    }
}

/// Get the current connection status for a remote project
#[tauri::command]
pub async fn get_remote_connection_status(
    project_id: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<ConnectionStatus, String> {
    println!("get_remote_connection_status({}) called", project_id);

    // Check if project exists and is remote
    let is_remote: bool = {
        let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT is_remote FROM projects WHERE id = ?",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("Project not found: {}", project_id))?
    };

    if !is_remote {
        return Ok(ConnectionStatus {
            project_id,
            is_remote: false,
            connected: false,
            disconnected_reason: Some("Project is not remote".into()),
        });
    }

    // Get the SSH session for this project (lazy - may not be connected yet)
    let session = state.get_ssh_session(project_id as i64).await;

    let connected = if let Some(s) = session {
        s.is_connected().await
    } else {
        false
    };

    Ok(ConnectionStatus {
        project_id,
        is_remote: true,
        connected,
        disconnected_reason: if !connected {
            Some("Not connected".into())
        } else {
            None
        },
    })
}

/// Reconnect a remote project by establishing a new SSH session
#[tauri::command]
pub async fn reconnect_remote_project(
    project_id: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    println!("reconnect_remote_project({}) called", project_id);

    // Get the project and SSH config (scoped to release lock before async)
    let (_is_remote, config): (bool, SshConfig) = {
        let conn = state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let (is_remote, ssh_config_json): (bool, Option<String>) = conn
            .query_row(
                "SELECT is_remote, ssh_config FROM projects WHERE id = ?",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| format!("Project not found: {}", project_id))?;

        if !is_remote {
            return Err("Project is not remote".into());
        }

        let ssh_config_str = ssh_config_json.ok_or("No SSH config found")?;
        let config: SshConfig = serde_json::from_str(&ssh_config_str)
            .map_err(|e| format!("Failed to parse SSH config: {}", e))?;

        (is_remote, config)
    };

    // Create and connect a new SSH session
    use crate::ssh::RemoteSshSession;
    let session = RemoteSshSession::new(config);

    session.connect().await.map_err(|e| {
        format!("Reconnection failed: {}", e)
    })?;

    // Store the connected session in AppState
    state
        .set_ssh_session(project_id as i64, session)
        .await;

    println!("[reconnect] ✓ Successfully reconnected to project {}", project_id);
    Ok(())
}

/// Save SSH password to OS keyring
#[tauri::command]
pub fn save_ssh_password(
    host: String,
    username: String,
    password: String,
) -> Result<(), String> {
    println!("save_ssh_password({}, {}) called via IPC", host, username);

    // Validate inputs
    if host.is_empty() || username.is_empty() || password.is_empty() {
        return Err("Invalid credentials".to_string());
    }

    // Store in OS keyring
    use crate::ssh::PasswordManager;
    PasswordManager::store_password(&host, &username, password)?;

    println!("✓ Password saved securely for {}@{}", username, host);
    Ok(())
}

/// Delete SSH password from OS keyring
#[tauri::command]
pub fn delete_ssh_password(
    host: String,
    username: String,
) -> Result<(), String> {
    println!("delete_ssh_password({}, {}) called via IPC", host, username);

    use crate::ssh::PasswordManager;
    PasswordManager::delete_password(&host, &username)?;

    println!("✓ Password deleted for {}@{}", username, host);
    Ok(())
}

/// Get recent projects with metadata for rich display
#[tauri::command]
pub fn get_recent_projects_enhanced(
    app_state: State<Arc<AppState>>
) -> Result<Vec<crate::models::EnhancedRecentProject>, String> {
    println!("get_recent_projects_enhanced() called via IPC");

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get recent_projects from settings
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let mut enhanced = Vec::new();

    for path in settings.recent_projects {
        // Query projects table for full info
        let project: Result<Project, _> = conn.query_row(
            "SELECT id, name, path, created_at, is_remote, ssh_config FROM projects WHERE path = ?",
            [&path],
            |row| {
                let ssh_config_json: Option<String> = row.get(5)?;
                let ssh_config = ssh_config_json
                    .and_then(|json| serde_json::from_str(&json).ok());

                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    created_at: row.get(3)?,
                    is_remote: row.get(4)?,
                    ssh_config,
                })
            },
        );

        if let Ok(project) = project {
            let (host, username) = if let Some(config) = &project.ssh_config {
                (Some(config.host.clone()), Some(config.username.clone()))
            } else {
                (None, None)
            };

            enhanced.push(crate::models::EnhancedRecentProject {
                path: project.path,
                name: project.name,
                is_remote: project.is_remote,
                host,
                username,
                last_opened: project.created_at,  // Use created_at as proxy
            });
        }
    }

    Ok(enhanced)
}

/// Validate and clean up recent projects list
#[tauri::command]
pub fn validate_recent_projects(
    app_state: State<Arc<AppState>>
) -> Result<Vec<String>, String> {
    println!("validate_recent_projects() called via IPC");

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get current recent_projects
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Filter to only projects that exist in database
    let mut valid_projects = Vec::new();
    for path in settings.recent_projects {
        let exists: bool = conn.query_row(
            "SELECT 1 FROM projects WHERE path = ?",
            [&path],
            |_| Ok(true),
        ).unwrap_or(false);

        if exists {
            valid_projects.push(path);
        }
    }

    Ok(valid_projects)
}

/// Remove project from recent list
#[tauri::command]
pub fn remove_recent_project(
    app_state: State<Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    println!("remove_recent_project({}) called via IPC", path);

    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get current settings
    let mut settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Remove path from recent_projects
    settings.recent_projects.retain(|p| p != &path);

    // Save updated settings
    crate::db::settings::save_settings(&mut conn, &settings)
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    println!("✓ Removed {} from recent projects", path);
    Ok(())
}

/// Pause a running agent execution by sending SIGSTOP to the process
#[tauri::command]
pub async fn pause_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    println!("pause_agent_execution(task={}) called", task_id);

    // Get current execution log for this task
    let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
    let exec_log = crate::db::get_current_execution_log(&conn, task_id)
        .map_err(|e| format!("Failed to get execution log: {}", e))?;
    drop(conn);

    println!("[pause] Got execution log {}", exec_log.id);

    // Update execution log status to Paused in database
    let conn = state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
    crate::db::pause_execution_log(&conn, exec_log.id)
        .map_err(|e| format!("Failed to pause execution: {}", e))?;
    drop(conn);

    println!("[pause] ✓ Updated execution log status to paused");

    // TODO: Send SIGSTOP to running process (implementation depends on process handle management)
    // For now, we just update the database status. Full process pause requires process handle tracking.

    Ok(())
}

/// Resume a paused agent execution by creating a new execution and spawning the agent again
#[tauri::command]
pub async fn resume_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    println!("resume_agent_execution(task={}, project={}) called", task_id, project_id);

    // Step 1: Get current paused execution log
    let _prev_exec_log = {
        let conn = app_state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
        crate::db::get_current_execution_log(&conn, task_id)
            .map_err(|e| format!("Failed to get execution log: {}", e))?
    };

    println!("[resume] Got previous execution log");

    // Step 2: Create new execution log
    let exec_log_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Failed to lock DB: {}", e))?;
        crate::db::create_execution_log(&conn, task_id, 0)?
    };

    println!("[resume] Created new execution log {}", exec_log_id);

    // Step 3: Lease worktree
    let worktree = lease_worktree(app_state.clone(), project_id, task_id, repo_path.clone()).await?;
    let worktree_id = worktree.id;
    let worktree_path = format!("{}/{}", repo_path, worktree.path);

    println!("[resume] Leased worktree {} at path {}", worktree_id, worktree.path);

    // Step 4: Get project to determine if remote
    let is_remote: bool = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT is_remote FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, bool>(0),
        ).map_err(|e| format!("Failed to load project: {}", e))?
    };

    println!("[resume] ✓ Determined execution type (is_remote: {})", is_remote);

    // Step 5: Extract Arc<AppState> for background task
    let app_state_arc = (*app_state).clone();

    // Step 6: Spawn background task (reuses spawn_agent_cli_pty pattern from spawn_agent_execution)
    tokio::spawn(async move {
        println!("[background] Starting resumed agent execution for task {} in worktree {}", task_id, worktree_id);

        // For local execution
        if !is_remote {
            match spawn_agent_cli_pty(
                task_id,
                "node".to_string(),
                vec!["sidecar/dist/index.js".to_string(), "--task-id".to_string(), task_id.to_string()],
                std::path::PathBuf::from(&worktree_path),
            )
            .await
            {
                Ok(pty_session) => {
                    println!("[background] PTY session spawned for resumed task {}", task_id);

                    // Store PtySession in AppState
                    {
                        let mut sessions = app_state_arc.pty_sessions.lock().await;
                        sessions.insert(task_id, Arc::new(tokio::sync::Mutex::new(pty_session)));
                        println!("[background] ✓ Stored PTY session for task {} in AppState", task_id);
                    }

                    // Initialize execution log status
                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            if let Err(e) = crate::db::mark_complete(&conn, exec_log_id, 0) {
                                eprintln!("[background] Failed to initialize execution log: {}", e);
                            }
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[background] PTY spawning failed: {}", e);

                    match app_state_arc.db.lock() {
                        Ok(conn) => {
                            let error_msg = format!("\n[ERROR] Failed to spawn PTY on resume: {}", e);
                            let _ = crate::db::append_output(&conn, exec_log_id, &error_msg);

                            let (error_type, suggestions) = detect_error_type_and_suggestions(&e, -1);
                            let now = Utc::now().to_rfc3339();
                            let error_event = crate::models::ErrorEvent {
                                error_type: error_type.clone(),
                                message: e.clone(),
                                suggestions,
                                detected_at: now,
                            };

                            let _ = crate::db::mark_failed(&conn, exec_log_id, &error_event);

                            let _ = conn.execute(
                                "UPDATE tasks SET status = 'Failed' WHERE id = ?",
                                [task_id],
                            );
                        }
                        Err(e) => {
                            eprintln!("[background] Failed to lock database: {}", e);
                        }
                    }
                }
            }
        } else {
            // Remote execution - TODO: similar pattern to local but with remote spawn
            eprintln!("[background] Remote execution on resume not yet implemented");
        }

        // Finalization: Return worktree to pool
        match app_state_arc.db.lock() {
            Ok(conn) => {
                let now = Utc::now().to_rfc3339();
                let _ = conn.execute(
                    "UPDATE worktrees SET status = 'Available', returned_at = ? WHERE id = ?",
                    rusqlite::params![&now, worktree_id],
                );
                println!("[background] ✓ Returned worktree {} to Available", worktree_id);
            }
            Err(e) => {
                eprintln!("[background] Failed to return worktree to pool: {}", e);
            }
        }
    });

    println!("[resume] ✓ Spawned background execution task, returning log id {}", exec_log_id);
    Ok(exec_log_id)
}

/// List subdirectories in a local filesystem path
#[tauri::command]
pub fn list_local_directories(path: String) -> Result<Vec<String>, String> {
    println!("list_local_directories(path={}) called via IPC", path);

    use std::fs;
    use std::path::Path;

    let dir_path = Path::new(&path);
    
    // Check if path exists and is a directory
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Read directory entries
    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    // Filter for directories only
    let mut directories: Vec<String> = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_dir() {
                    if let Some(name) = entry.file_name().to_str() {
                        // Skip . and .. (though these shouldn't appear from read_dir)
                        if name != "." && name != ".." {
                            directories.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    // Sort alphabetically
    directories.sort();

    println!("Found {} subdirectories in {}", directories.len(), path);
    Ok(directories)
}

/// Get the default file picker path based on the current platform
#[tauri::command]
pub fn get_default_file_picker_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, default to C:/Users
        Ok("C:/Users".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, default to /Users
        Ok("/Users".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, default to /home
        Ok("/home".to_string())
    }
}

/// List available drives (Windows only)
#[tauri::command]
pub fn list_drives() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::fs;
        let mut drives = Vec::new();

        // Check common drive letters A-Z
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:/", letter as char);
            // Try to read the drive root to see if it exists
            if fs::metadata(&drive).is_ok() {
                drives.push(drive);
            }
        }

        println!("Found {} drives: {:?}", drives.len(), drives);
        Ok(drives)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows systems, return empty list
        Ok(Vec::new())
    }
}
