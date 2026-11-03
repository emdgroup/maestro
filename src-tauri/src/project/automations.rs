//! Automations: an agent this project runs on its own, for work nobody should have to file a task
//! for.
//!
//! An automation is not a task and does not enter the pipeline. It is a prompt, an agent to run it
//! and a workspace to run it in; what the run *produces* — a file, a commit, a pull request, a
//! task — is whatever the prompt asks for, using the tools the agent already has. That is why
//! there is no output field here: the prompt is the contract.
//!
//! **Nothing is stored on this side.** They live in the resident server's own database, on the
//! machine the project lives on, because the clock that fires them has to keep running when this
//! window is closed. Everything below is a round trip to that server, which is also the only thing
//! that ever decides what a project's canonical path is.

use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{
    query_automation_runs_via_server, query_delete_automation_run_via_server,
    query_delete_automation_via_server, query_list_automations_via_server,
    query_preview_schedule_via_server, query_roll_webhook_secret_via_server,
    query_run_automation_via_server, query_save_automation_via_server,
    query_set_run_retention_via_server, query_webhook_deliveries_via_server,
    query_webhook_settings_via_server,
};
use crate::acp::ConnectionKey;
use crate::core::AppState;

pub use maestro_protocol::{
    Automation, AutomationRun, AutomationRunStatus, AutomationWorkspace, DeliveryOutcome,
    ListAutomationsResponse, RunRetention, RunTrigger, WebhookDelivery, WebhookOverlap,
    WebhookSettings, WebhookStatus,
};

/// Which server to ask, and what this project is called on it.
///
/// Read from the `projects` row alone: every task, worktree and review request comes through here,
/// and building a `GitConnection` for each would look up the connection's credentials to no end.
pub(crate) async fn target(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<(ConnectionKey, String), String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?;
    conn.query_row(
        "SELECT path, connection_id, wsl_connection_id, docker_connection_id
         FROM projects WHERE id = ?1",
        [project_id],
        |row| {
            Ok((
                ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?),
                row.get(0)?,
            ))
        },
    )
    .map_err(|e| format!("Project {project_id} not found: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn list_automations(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<ListAutomationsResponse, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    query_list_automations_via_server(connection_key, project_path, &app_state).await
}

/// Create or replace one automation.
///
/// One at a time rather than a whole document, because the store is a set of rows now: a
/// whole-document write would have two windows overwriting each other with whatever each last read.
#[tauri::command]
#[specta::specta]
pub async fn save_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation: Automation,
) -> Result<Automation, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    query_save_automation_via_server(connection_key, project_path, automation, &app_state).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<(), String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_delete_automation_via_server(connection_key, automation_id, &app_state).await
}

/// Fire one now, whatever its schedule says.
///
/// Returns as soon as the server has opened a run for it. What happens next arrives as
/// `automation-run-changed`, the same way a scheduled run does — there is deliberately no second
/// path for a run somebody asked for by hand.
#[tauri::command]
#[specta::specta]
pub async fn run_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<(), String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_run_automation_via_server(connection_key, automation_id, &app_state).await
}

/// When a schedule being written would next fire, RFC 3339, or `None` for one that never does.
///
/// Asked of the server rather than worked out here, for the same reason `next_due_at` is: the
/// daemon is what decides when a run happens, and a second implementation in the editor would be
/// a second answer to that question.
#[tauri::command]
#[specta::specta]
pub async fn preview_schedule(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    cron: String,
    timezone: String,
) -> Result<Option<String>, String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    let response =
        query_preview_schedule_via_server(connection_key, cron, timezone, &app_state).await?;
    Ok(response.next)
}

/// Take over the session an automation just started, so its output and its questions reach this
/// window.
///
/// Project opening adopts whatever is already running, but a run the clock or Run now starts
/// afterwards arrives while the window is attached, and nothing else would pick it up: the
/// server's messages for it were dropped for want of a session to route them to, elicitations
/// included. Returns whether it was adopted; `false` for one this window already holds.
#[tauri::command]
#[specta::specta]
pub async fn adopt_automation_session(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    session_id: String,
) -> Result<bool, String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    let adopted = crate::acp::session_ops::attach_project_sessions(
        connection_key,
        project_id,
        Some(&session_id),
        &app_state,
    )
    .await;
    Ok(adopted > 0)
}

#[tauri::command]
#[specta::specta]
pub async fn list_automation_runs(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    let response =
        query_automation_runs_via_server(connection_key, project_path, limit, &app_state).await?;
    Ok(response.runs)
}

/// Forget one run, removing the worktree and branch it made if they are still there, whatever
/// they hold. Refused for a run still going, or one whose session is still open.
#[tauri::command]
#[specta::specta]
pub async fn delete_automation_run(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    run_id: String,
) -> Result<(), String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_delete_automation_run_via_server(connection_key, run_id, &app_state).await
}

/// Set how much run history this project keeps. Applied straight away.
#[tauri::command]
#[specta::specta]
pub async fn set_run_retention(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    retention: RunRetention,
) -> Result<(), String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    query_set_run_retention_via_server(connection_key, project_path, retention, &app_state).await
}

/// This machine's webhook listener, for the connection's Settings page.
#[tauri::command]
#[specta::specta]
pub async fn get_webhook_settings(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<WebhookStatus, String> {
    query_webhook_settings_via_server(connection, None, &app_state).await
}

/// Change the listener. The server rebinds before answering, so the status says whether the new
/// address works.
#[tauri::command]
#[specta::specta]
pub async fn set_webhook_settings(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    settings: WebhookSettings,
) -> Result<WebhookStatus, String> {
    query_webhook_settings_via_server(connection, Some(settings), &app_state).await
}

/// Replace an automation's webhook secret. Every sender using the old one stops working.
#[tauri::command]
#[specta::specta]
pub async fn roll_webhook_secret(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<Automation, String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_roll_webhook_secret_via_server(connection_key, automation_id, &app_state).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_webhook_deliveries(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<Vec<WebhookDelivery>, String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    let response =
        query_webhook_deliveries_via_server(connection_key, automation_id, &app_state).await?;
    Ok(response.deliveries)
}
