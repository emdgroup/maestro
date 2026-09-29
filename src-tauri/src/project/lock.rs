//! Project locks, held by the resident server of the connection a project lives on.
//!
//! The server owns them, in memory, keyed by canonical project path: two windows are kept off one
//! project whether they share a data directory or not, and a lock dies with the relay that took it,
//! so a crashed window never leaves a project stuck. This side only asks, and remembers in
//! `AppState::active_project_lock` which project it holds and on which connection.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{Arc, OnceLock};
use tauri::State;

use crate::acp::connection_server::{
    query_acquire_project_lock_via_server, query_project_locks_via_server,
    query_takeover_via_server, send_via_server,
};
use crate::acp::discovery_handlers::ensure_connection_server;
use crate::acp::transport::{MaestroRpcMessage, ServerRequest};
use crate::acp::ConnectionKey;
use crate::command_ext::NoConsoleWindow;
use crate::core::AppState;
use crate::project::Project;

/// Marks the one error the frontend branches on rather than just displaying.
/// `isProjectLockedError` in `src/utils/helpers/error-utils.ts` matches this prefix, so the
/// two must be changed together. What follows it is the holder's label.
pub const PROJECT_LOCKED_PREFIX: &str = "PROJECT_LOCKED:";

/// How this window introduces itself to whoever it takes a project from.
fn label() -> &'static str {
    static LABEL: OnceLock<String> = OnceLock::new();
    LABEL.get_or_init(|| {
        std::process::Command::new("hostname")
            .no_console_window()
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "another machine".to_string())
    })
}

fn connection_of(project: &Project) -> ConnectionKey {
    ConnectionKey::from_all_ids(
        project.connection_id,
        project.wsl_connection_id,
        project.docker_connection_id,
    )
}

pub(crate) fn load_project(app_state: &AppState, project_id: i32) -> Result<Project, String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
        [project_id],
        Project::from_row,
    )
    .map_err(|_| "Project not found".to_string())
}

fn request(project: &Project) -> maestro_protocol::AcquireProjectLockRequest {
    maestro_protocol::AcquireProjectLockRequest {
        project_path: project.path.clone(),
        label: label().to_string(),
    }
}

/// Take `project` for this window. Errors with [`PROJECT_LOCKED_PREFIX`] when another window
/// holds it, and plainly when the server cannot be reached: the project cannot be opened safely
/// without asking.
pub async fn acquire(app_state: &Arc<AppState>, project: &Project) -> Result<(), String> {
    let key = connection_of(project);
    ensure_connection_server(app_state, key).await?;
    let resp = query_acquire_project_lock_via_server(key, request(project), app_state).await?;
    if !resp.acquired {
        return Err(format!(
            "{PROJECT_LOCKED_PREFIX}{}",
            resp.holder_label.as_deref().unwrap_or("another machine")
        ));
    }

    // The server let go of whatever this relay held before. A lock on another connection is held
    // by another relay, and has to be let go of by hand.
    let previous = app_state
        .active_project_lock
        .lock()
        .map_err(|e| format!("Lock state error: {}", e))?
        .replace((project.id, key));
    if let Some((_, previous_key)) = previous.filter(|(_, k)| *k != key) {
        let release = MaestroRpcMessage::Request(ServerRequest::ReleaseProjectLock);
        if let Err(e) = send_via_server(previous_key, app_state, release).await {
            log::warn!("could not release the project lock on {previous_key:?}: {e}");
        }
    }
    Ok(())
}

/// Take the project back after a relay was replaced, as an SSH reconnect does.
///
/// The old relay's lock is only released once the server notices it is gone, which for a dropped
/// network can take until it goes stale, so a refusal is retried for that long before this window
/// concludes someone else really has the project.
pub async fn reacquire(app_state: Arc<AppState>, key: ConnectionKey) {
    const ATTEMPTS: u32 = 8;
    for attempt in 1..=ATTEMPTS {
        let held = app_state
            .active_project_lock
            .lock()
            .ok()
            .and_then(|held| *held)
            .filter(|(_, k)| *k == key);
        let Some((project_id, _)) = held else {
            return;
        };
        let Ok(project) = load_project(&app_state, project_id) else {
            return;
        };
        match query_acquire_project_lock_via_server(key, request(&project), &app_state).await {
            // Checked again because `acquire` may have moved this window to another project on the
            // same connection meanwhile, and that one is what should end up held.
            Ok(resp) if resp.acquired => {
                let still = app_state
                    .active_project_lock
                    .lock()
                    .is_ok_and(|held| *held == Some((project_id, key)));
                if still {
                    return;
                }
            }
            Ok(resp) if attempt == ATTEMPTS => {
                if let Ok(mut held) = app_state.active_project_lock.lock() {
                    *held = None;
                }
                let by = resp
                    .holder_label
                    .unwrap_or_else(|| "another machine".into());
                crate::core::emit_or_log(
                    &app_state.app_handle,
                    "project-kicked",
                    &serde_json::json!({
                        "project_path": project.path,
                        "reason": { "kind": "taken_over", "by": by },
                    }),
                );
                return;
            }
            Ok(_) => tokio::time::sleep(std::time::Duration::from_secs(5)).await,
            Err(e) => {
                log::warn!("could not take project {project_id} back on {key:?}: {e}");
                return;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectLockEntry {
    pub project_id: i32,
    pub holder_label: String,
    /// Held by this window.
    pub yours: bool,
}

/// Which of these projects some window holds, for the picker's lock badges.
#[tauri::command]
#[specta::specta]
pub async fn list_project_locks(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    project_ids: Vec<i32>,
) -> Result<Vec<ProjectLockEntry>, String> {
    let projects: Vec<(i32, String)> = project_ids
        .into_iter()
        .filter_map(|id| load_project(&app_state, id).ok())
        .map(|project| (project.id, project.path))
        .collect();
    ensure_connection_server(&app_state, connection).await?;
    let resp = query_project_locks_via_server(
        connection,
        projects.iter().map(|(_, path)| path.clone()).collect(),
        &app_state,
    )
    .await?;
    Ok(resp
        .locks
        .into_iter()
        .filter_map(|lock| {
            let (project_id, _) = projects.iter().find(|(_, p)| *p == lock.project_path)?;
            Some(ProjectLockEntry {
                project_id: *project_id,
                holder_label: lock.holder_label,
                yours: lock.yours,
            })
        })
        .collect())
}

/// Ask whoever holds a project to give it up. `true` once it is this window's; the caller opens
/// it as usual after that.
#[tauri::command]
#[specta::specta]
pub async fn request_project_takeover(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<bool, String> {
    let project = load_project(&app_state, project_id)?;
    let key = connection_of(&project);
    ensure_connection_server(&app_state, key).await?;
    query_takeover_via_server(key, request(&project), &app_state).await
}

/// This window's answer to a `project-takeover-requested` event.
#[tauri::command]
#[specta::specta]
pub async fn answer_project_takeover(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    request_id: String,
    accept: bool,
) -> Result<(), String> {
    send_via_server(
        connection,
        &app_state,
        MaestroRpcMessage::Request(ServerRequest::TakeoverAnswer(
            maestro_protocol::TakeoverAnswer { request_id, accept },
        )),
    )
    .await
}
