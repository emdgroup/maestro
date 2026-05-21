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
        _ => Err("Provider not yet supported in this phase".to_string()),
    }
}
