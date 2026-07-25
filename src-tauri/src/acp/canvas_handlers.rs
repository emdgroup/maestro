use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

fn project_path(state: &AppState, project_id: i32) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("Project {} not found", project_id))
}

async fn get_acp_session_id(state: &AppState, log_id: i32) -> Result<String, String> {
    let sessions = state.acp.sessions.lock().await;
    let session = sessions
        .get(&log_id)
        .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
    let id = session
        .acp_session_id
        .lock()
        .map_err(|_| "acp_session_id lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Session not yet initialized (no acp_session_id)".to_string());
    id
}

fn canvas_dir(project_path: &str, acp_session_id: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".maestro")
        .join("canvases")
        .join(acp_session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn save_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
    surface_id: String,
    surface: serde_json::Value,
) -> Result<(), String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let dir = canvas_dir(&path, &acp_session_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create canvas directory: {}", e))?;
    let file_path = dir.join(format!("{}.json", surface_id));
    let contents = serde_json::to_vec_pretty(&surface)
        .map_err(|e| format!("Failed to serialize canvas: {}", e))?;
    tokio::fs::write(&file_path, contents)
        .await
        .map_err(|e| format!("Failed to write canvas file: {}", e))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
    surface_id: String,
) -> Result<(), String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let file_path = canvas_dir(&path, &acp_session_id).join(format!("{}.json", surface_id));
    match tokio::fs::remove_file(&file_path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete canvas file: {}", e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn load_saved_canvases(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
) -> Result<Vec<serde_json::Value>, String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let dir = canvas_dir(&path, &acp_session_id);
    let mut read_dir = match tokio::fs::read_dir(&dir).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Failed to read canvas directory: {}", e)),
    };
    let mut surfaces = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory entry: {}", e))?
    {
        let entry_path = entry.path();
        if entry_path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let contents = match tokio::fs::read_to_string(&entry_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        match serde_json::from_str::<serde_json::Value>(&contents) {
            Ok(value) => surfaces.push(value),
            Err(_) => continue,
        }
    }
    Ok(surfaces)
}
