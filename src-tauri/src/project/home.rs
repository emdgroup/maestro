//! What Home shows for one connection, in one round trip to its server.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{query_via_server, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HomeSummary {
    pub version: String,
    /// RFC 3339.
    pub started_at: String,
    pub live_sessions: u32,
    /// Automation runs still going, across every project on the connection.
    pub running_runs: u32,
    /// This machine's name, for This computer only.
    pub hostname: Option<String>,
    pub projects: Vec<HomeProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HomeProject {
    /// `None` for a project only the server knows, which opening registers here.
    pub project_id: Option<i32>,
    pub path: String,
    /// The folder's name.
    pub name: String,
    pub queued: u32,
    pub in_progress: u32,
    pub review: u32,
    /// Agents mid-turn.
    pub working_agents: u32,
    /// Prompts waiting on the user, plus tasks with the ball on the user.
    pub needs_you: u32,
    pub blocking_prompt: Option<String>,
    pub running_automations: Vec<String>,
    pub lock_holder: Option<String>,
    /// Held by this window.
    pub lock_yours: bool,
}

/// The connection's server status and every project it or this app knows of. Never starts a
/// relay: a connection Home has not attached to answers "No connection server".
#[tauri::command]
#[specta::specta]
pub async fn get_home_summary(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<HomeSummary, String> {
    let recent: Vec<(i32, String)> = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        crate::project::crud::fetch_projects_from_db(&conn, connection)?
            .into_iter()
            .map(|project| (project.id, project.path))
            .collect()
    };
    let summary = query_via_server(
        connection,
        &app_state,
        &format!("No connection server for connection {:?}", connection),
        ServerRequest::HomeSummary(maestro_protocol::HomeSummaryRequest {
            project_paths: recent.iter().map(|(_, path)| path.clone()).collect(),
        }),
        reply!(ServerResponse::HomeSummaryOk(summary) => summary),
        15,
        "The connection's server did not answer within 15s",
    )
    .await?;
    let projects = summary
        .projects
        .into_iter()
        .map(|project| HomeProject {
            project_id: recent
                .iter()
                .find(|(_, path)| *path == project.project_path)
                .map(|(id, _)| *id),
            name: project
                .project_path
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or(&project.project_path)
                .to_string(),
            path: project.project_path,
            queued: project.queued,
            in_progress: project.in_progress,
            review: project.review,
            working_agents: project.working_agents,
            needs_you: project.needs_you,
            blocking_prompt: project.blocking_prompt,
            running_automations: project.running_automations,
            lock_holder: project.lock_holder,
            lock_yours: project.lock_yours,
        })
        .collect();
    Ok(HomeSummary {
        version: summary.status.version,
        started_at: summary.status.started_at,
        live_sessions: summary.status.live_sessions,
        running_runs: summary.status.running_runs,
        hostname: matches!(connection, ConnectionKey::Local)
            .then(crate::project::lock::hostname)
            .flatten()
            .map(str::to_string),
        projects,
    })
}
