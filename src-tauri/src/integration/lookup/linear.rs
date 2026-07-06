use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::integration::linear::LinearTeam;

/// List all Linear teams in the authenticated workspace.
#[tauri::command]
#[specta::specta]
pub async fn list_linear_teams(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<LinearTeam>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("linear", &app_state)?;
    crate::integration::linear::list_teams(&creds.token).await
}
