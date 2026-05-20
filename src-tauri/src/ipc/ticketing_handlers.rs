use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
use crate::models::ticketing::TicketingConfig;
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

    let config = TicketingConfig {
        updated_at: now_rfc3339(),
        ..config
    };

    config.save_to_project(&path)
}
