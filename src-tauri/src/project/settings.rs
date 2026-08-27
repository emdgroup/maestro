use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::core::AppState;
use crate::core::project_storage::{read_maestro_json, write_maestro_json};

pub const SETTINGS_FILE: &str = "settings.json";

/// Read `.maestro/settings.json` for a project, from whichever machine the project lives on.
///
/// A missing or unparseable file yields the default config: a project that has never opened the
/// settings UI has no file at all, and that is not an error.
pub async fn load_project_config_for(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<crate::models::ProjectConfig, String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(read_maestro_json(&conn, SETTINGS_FILE).await)
}

/// Get project-level configuration from .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn get_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    let config = load_project_config_for(&app_state, project_id).await?;
    Ok(crate::models::ProjectConfigResponse {
        default_agent: config.default_agent,
        startup_tab: config.startup_tab,
        accent_color: config.accent_color,
        accent_color_auto_assign: config.accent_color_auto_assign,
        default_worktree: config.default_worktree,
    })
}

/// Set only the project's accent colour in .maestro/settings.json.
///
/// Separate from `update_project_settings` so the settings form (which writes the whole
/// `ProjectConfigRequest`) can never clobber a colour picked in the header a moment earlier.
#[tauri::command]
#[specta::specta]
pub async fn set_project_accent_color(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    accent_color: Option<String>,
) -> Result<(), String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let mut config: crate::models::ProjectConfig = read_maestro_json(&conn, SETTINGS_FILE).await;
    config.accent_color = accent_color;
    // Records that the colour is now settled, whether that is a hue or a deliberate "follow
    // the global default" — the latter stores no hue, so without this the first-open
    // assignment would overwrite the choice on the next open.
    config.accent_color_auto_assign = Some(false);
    config.updated_at = Utc::now().to_rfc3339();

    write_maestro_json(&conn, SETTINGS_FILE, &config).await
}

/// Update project-level configuration in .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn update_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    // Load-modify-save to preserve fields managed by other handlers (e.g. issue_tracking).
    let mut config: crate::models::ProjectConfig = read_maestro_json(&conn, SETTINGS_FILE).await;
    config.default_agent = settings.default_agent;
    config.startup_tab = settings.startup_tab;
    config.default_worktree = settings.default_worktree;
    config.updated_at = Utc::now().to_rfc3339();

    write_maestro_json(&conn, SETTINGS_FILE, &config).await
}
