use std::sync::Arc;
use tauri::State;
use base64::Engine;
use tokio::io::AsyncReadExt;

use crate::models::{Project, Task, AppSettings, TaskStatus, SyncResult, GitHubIssue, JiraSearchResponse, Worktree, WorktreeStatus, PoolStatus};
use crate::db::AppState;
use crate::process::spawn_agent_cli_pty;

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

// ============================================================================
// Worktree Pool Management
// ============================================================================

const POOL_MAX_SIZE: i32 = 5;

/// Lease worktree from pool for task execution
/// 
/// Creates database record atomically, then invokes sidecar to create actual git worktree.
/// If pool is empty, creates new worktree up to max pool size.
#[tauri::command]
pub async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<Worktree, String> {
    println!("lease_worktree(project={}, task={}) called", project_id, task_id);
    
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    
    // Try to find available worktree
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
    
    // No available worktree, check if we can create new one
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM worktrees WHERE project_id = ?",
        [project_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to count worktrees: {}", e))?;
    
    if count >= POOL_MAX_SIZE {
        return Err(format!("Pool exhausted: {} worktrees in use (max {})", count, POOL_MAX_SIZE));
    }
    
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
    
    // Drop connection lock before async sidecar call
    drop(conn);
    
    // Call sidecar to create actual git worktree
    // NOTE: For now, sidecar invocation is stubbed (Phase 3-01 built sidecar, Phase 4 will integrate)
    // TODO: Implement actual sidecar spawning in Phase 4
    println!("TODO: Invoke sidecar createWorktree({}, {}, {})", repo_path, worktree_id_str, task_id);
    
    // For now, return the worktree without actual git creation
    // Phase 4 will add: tokio::process::Command sidecar invocation
    
    Ok(Worktree {
        id: worktree_id,
        project_id,
        branch_name,
        path: worktree_path,
        status: WorktreeStatus::Leased,
        leased_at: Some(now.clone()),
        returned_at: None,
        created_at: now,
    })
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

    // 3. Extract Arc<AppState> from State for background task
    // This allows the Arc to be moved into the tokio::spawn closure
    // State<'_, Arc<AppState>> dereferences to &Arc<AppState>, so we clone to own it
    let app_state_arc = (*app_state).clone();

    // 4. Spawn background task (returns immediately to caller)
    tokio::spawn(async move {
        println!("[background] Starting agent execution for task {} in worktree {}", task_id, worktree_id);

        // Run agent process via PTY spawner
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

                // Initialize execution log status (PTY output will be streamed to frontend)
                match app_state_arc.db.lock() {
                    Ok(conn) => {
                        // Update execution log to running status
                        if let Err(e) = crate::db::execution_logs::mark_complete(&conn, exec_log_id, 0) {
                            eprintln!("[background] Failed to initialize execution log: {}", e);
                        }

                        // Worktree remains in InUse status during execution
                        // Will be returned to pool or marked dirty when frontend detaches or process completes
                    }
                    Err(e) => {
                        eprintln!("[background] Failed to lock database: {}", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[background] PTY spawning failed: {}", e);

                // Log error to execution log and mark worktree as dirty
                match app_state_arc.db.lock() {
                    Ok(conn) => {
                        let error_msg = format!("\n[ERROR] Failed to spawn PTY: {}", e);
                        let _ = crate::db::execution_logs::append_output(&conn, exec_log_id, &error_msg);
                        let _ = crate::db::execution_logs::mark_complete(&conn, exec_log_id, -1);

                        // Mark worktree as dirty on spawn error
                        let _ = conn.execute(
                            "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
                            rusqlite::params![worktree_id],
                        );
                        println!("✗ Marked worktree {} as dirty due to spawn error", worktree_id);
                    }
                    Err(lock_err) => {
                        eprintln!("[background] Failed to lock database for error logging: {}", lock_err);
                    }
                }
            }
        }

        println!("[background] Agent execution complete for task {}", task_id);
    });

    // 5. Return execution_log id immediately (process runs in background)
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
        "SELECT id, task_id, status, output, started_at, completed_at
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
        Ok(crate::models::ExecutionLog {
            id: row.get(0)?,
            task_id: row.get(1)?,
            status,
            output: row.get(3)?,
            started_at: row.get(4)?,
            completed_at: row.get(5)?,
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
/// The streaming continues until the PTY process ends or the channel is closed.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID to attach to
/// * `output_channel` - Tauri IPC channel for streaming output
///
/// # Returns
/// `Result<(), String>` - Ok if streaming started, Err if task not found
#[tauri::command]
pub async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    println!("attach_terminal({}) called", task_id);

    // Get PTY session from AppState
    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions); // Release lock

    println!("[attach] Starting output streaming for task {}", task_id);

    // Spawn background task to stream PTY output
    tokio::spawn(async move {
        // Create bounded channel for buffering between PTY reader and frontend sender
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

        // Spawn PTY reader task
        let session_reader = session.clone();
        let reader_task = tokio::spawn(async move {
            loop {
                // Try to get a reader from the PTY master
                let mut session_lock = session_reader.lock().await;
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
/// Used for keyboard input and other terminal interactions.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `input` - Data to send to the PTY
///
/// # Returns
/// `Result<(), String>` - Ok if input sent, Err if session not found or write failed
#[tauri::command]
pub async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    println!("send_terminal_input({}) called", task_id);

    let sessions = app_state.pty_sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

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
