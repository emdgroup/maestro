use std::sync::Arc;
use std::fs;
use std::path::Path;
use tauri::State;
use crate::db::AppState;
use crate::models::ticketing::{ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;

#[tauri::command]
#[specta::specta]
pub async fn get_ticketing_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<TicketingConfig, String> {
    let path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    Ok(TicketingConfig::load_from_project(&path).unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub async fn save_ticketing_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    config: TicketingConfig,
) -> Result<(), String> {
    let path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    if config.provider.is_some() {
        // Clear any stale credential so the next fetch_remote_issues is forced
        // through a validate_and_store path. Best-effort — not fatal if no token stored.
        let _ = app_state.token_manager.delete_token(
            project_id,
            &app_state.app_data_dir,
            &app_state.app_handle,
        );
    }

    let config = TicketingConfig {
        updated_at: now_rfc3339(),
        ..config
    };

    config.save_to_project(&path)
}

#[tauri::command]
#[specta::specta]
pub async fn save_github_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: Option<String>,
) -> Result<String, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::github::validate_and_store(
        project_id,
        &owner,
        &repo,
        token,
        &project_path,
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_gitlab_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    instance_url: String,
    project_path: String,
    token: String,
) -> Result<String, String> {
    let db_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::gitlab::validate_and_store(
        project_id,
        &instance_url,
        &project_path,
        &token,
        &db_path,
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_forgejo_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    instance_url: String,
    owner: String,
    repo: String,
    token: String,
) -> Result<String, String> {
    let db_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::forgejo::validate_and_store(
        project_id,
        &instance_url,
        &owner,
        &repo,
        &token,
        &db_path,
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_linear_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    api_key: String,
) -> Result<String, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::linear::validate_and_store(project_id, &api_key, &project_path, &app_state).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_linear_teams(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<crate::ticketing::linear::LinearTeam>, String> {
    let token = app_state
        .token_manager
        .get_token(project_id, &app_state.app_data_dir, &app_state.app_handle)?
        .ok_or_else(|| "No stored Linear credentials found".to_string())?;
    crate::ticketing::linear::list_teams(&token.access_token).await
}

#[tauri::command]
#[specta::specta]
pub async fn save_jira_cloud_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    site_url: String,
    email: String,
    api_token: String,
    project_key: String,
) -> Result<String, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::jira_cloud::validate_and_store(
        project_id,
        &site_url,
        &email,
        &api_token,
        &project_key,
        &project_path,
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_azure_devops_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    org_url: String,
    project: String,
    token: String,
) -> Result<String, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    crate::ticketing::azure_devops::validate_and_store(
        project_id,
        &org_url,
        &project,
        &token,
        &project_path,
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_ticketing_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    app_state.token_manager.delete_token(
        project_id,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;
    let config_path = Path::new(&project_path)
        .join(".maestro")
        .join("ticketing.json");
    if config_path.exists() {
        fs::remove_file(&config_path)
            .map_err(|e| format!("Failed to remove ticketing.json: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_remote_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<RemoteIssue>, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    let config = TicketingConfig::load_from_project(&project_path)
        .map_err(|_| "No ticketing provider configured".to_string())?;
    let provider = config
        .provider
        .ok_or_else(|| "No ticketing provider configured".to_string())?;
    let token = app_state
        .token_manager
        .get_token(project_id, &app_state.app_data_dir, &app_state.app_handle)?
        .ok_or_else(|| "No stored credentials found".to_string())?;
    match provider {
        ProviderConfig::Github(cfg) => {
            crate::ticketing::github::fetch_issues(&cfg.owner, &cfg.repo, &token.access_token)
                .await
        }
        ProviderConfig::Gitlab(cfg) => {
            crate::ticketing::gitlab::fetch_issues(
                &cfg.instance_url,
                cfg.project_id,
                &token.access_token,
            )
            .await
        }
        ProviderConfig::Forgejo(cfg) => {
            crate::ticketing::forgejo::fetch_issues(
                &cfg.instance_url,
                &cfg.owner,
                &cfg.repo,
                &token.access_token,
            )
            .await
        }
        ProviderConfig::Linear(cfg) => {
            crate::ticketing::linear::fetch_issues(&token.access_token, cfg.team_id.as_deref()).await
        }
        ProviderConfig::Jiracloud(cfg) => {
            crate::ticketing::jira_cloud::fetch_issues(
                &cfg.site_url,
                &cfg.email,
                &token.access_token,
                &cfg.project_key,
            )
            .await
        }
        ProviderConfig::Jiraserver(_cfg) => {
            Err("Jira Server is no longer supported — migrate to Jira Cloud".to_string())
        }
        ProviderConfig::Azuredevops(cfg) => {
            crate::ticketing::azure_devops::fetch_issues(
                &cfg.org_url,
                &cfg.project,
                &token.access_token,
            )
            .await
        }
    }
}
