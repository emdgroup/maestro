use std::sync::Arc;
use crate::core::AppState;
use crate::core::project_storage::{read_maestro_json, write_maestro_json};
use crate::acp::ConnectionKey;
use crate::models::GitConnection;

const STATE_FILE: &str = "state.json";

/// Resolve the connection a project's `.maestro/state.json` lives behind. `None` when the
/// connection is not available — every caller here is best-effort and treats that as no state.
async fn state_connection(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Option<GitConnection> {
    crate::core::git_connection_for(app_state, project_path.to_string(), connection_key)
        .await
        .ok()
}

/// Read `.maestro/state.json` from wherever the project lives. A missing or unreadable file is
/// indistinguishable from an empty one here — callers only ever add to what they get back.
pub(crate) async fn read_project_state(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) -> crate::project::models::ProjectState {
    match state_connection(app_state, project_path, connection_key).await {
        Some(conn) => read_maestro_json(&conn, STATE_FILE).await,
        None => Default::default(),
    }
}

/// Write `.maestro/state.json` back to wherever the project lives. Best-effort: every caller is
/// fire-and-forget, and a failed write only costs the user the state it would have carried.
async fn write_project_state(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
    project_state: &crate::project::models::ProjectState,
) {
    let Some(conn) = state_connection(app_state, project_path, connection_key).await else {
        return;
    };
    if let Err(e) = write_maestro_json(&conn, STATE_FILE, project_state).await {
        log::warn!("[state] writing state.json for {project_path} failed: {e}");
    }
}

/// Express a session's working directory relative to the project root, so it still resolves when
/// the project sits at a different absolute path. `Some("")` is the project root itself; `None`
/// means the directory lies outside the project and cannot be recorded portably.
fn relative_to_project(project_path: &str, cwd: &str) -> Option<String> {
    let normalize = |path: &str| path.replace('\\', "/").trim_end_matches('/').to_string();
    let root = normalize(project_path);
    let dir = normalize(cwd);
    if dir == root {
        return Some(String::new());
    }
    dir.strip_prefix(&format!("{root}/")).map(str::to_string)
}

/// Write the current live sessions for a project to `.maestro/state.json`.
/// Called fire-and-forget via tokio::spawn after session spawn/cancel.
/// The folder each session runs in is recorded alongside it, because Session History needs it.
pub async fn save_current_sessions_for_project(app_state: Arc<AppState>, project_id: i32) {
    if app_state.is_closing.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }

    let (project_path, connection_key) = {
        match app_state.db.lock() {
            Ok(conn) => match conn.query_row(
                "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
                [project_id],
                |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?))),
            ) {
                Ok(row) => row,
                Err(_) => return,
            },
            Err(_) => return,
        }
    };

    let (snapshots, folders) = {
        let sessions = app_state.acp.sessions.lock().await;
        let mut snapshots: Vec<crate::project::models::SessionSnapshot> = vec![];
        let mut folders: Vec<crate::project::models::SessionFolder> = vec![];
        for proc in sessions.values().filter(|proc| proc.project_id == Some(project_id)) {
            let Some(acp_session_id) = proc.acp_session_id.lock().ok().and_then(|id| id.clone())
            else {
                continue;
            };
            if let Some(relative_path) = relative_to_project(&project_path, &proc.cwd) {
                folders.push(crate::project::models::SessionFolder {
                    agent_id: proc.agent_id_meta.clone(),
                    acp_session_id: acp_session_id.clone(),
                    relative_path,
                });
            }
            snapshots.push(crate::project::models::SessionSnapshot {
                agent_id: proc.agent_id_meta.clone(),
                acp_session_id,
                cwd: proc.cwd.clone(),
                session_name: proc.session_name.clone(),
                connection_key: proc.connection_key,
                branch_name: proc.branch_name.clone(),
                task_id: proc.task_id,
            });
        }
        (snapshots, folders)
    };

    if snapshots.is_empty() && folders.is_empty() {
        return;
    }

    let mut project_state = read_project_state(&app_state, &project_path, connection_key).await;
    for folder in folders {
        match project_state.session_folders.iter_mut().find(|existing| {
            existing.agent_id == folder.agent_id
                && existing.acp_session_id == folder.acp_session_id
        }) {
            // Re-record rather than skip: a session reopened elsewhere now lives elsewhere.
            Some(existing) => *existing = folder,
            None => project_state.session_folders.push(folder),
        }
    }
    project_state.restorable_sessions = snapshots;

    write_project_state(&app_state, &project_path, connection_key, &project_state).await;
}


/// Read `.maestro/state.json` for a project and return stored session snapshots without clearing.
/// Returns an empty vec if state.json is missing, unreadable, or has no sessions.
pub(crate) async fn read_session_snapshots(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Vec<crate::project::models::SessionSnapshot> {
    read_project_state(app_state, project_path, connection_key)
        .await
        .restorable_sessions
}

/// Read `.maestro/state.json` for a project, extract restorable sessions, and save back cleared state.
/// Returns an empty vec if state.json is missing, unreadable, or has no sessions.
pub(crate) async fn read_and_clear_restorable_sessions(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Vec<crate::project::models::SessionSnapshot> {
    let mut project_state = read_project_state(app_state, project_path, connection_key).await;

    let sessions = std::mem::take(&mut project_state.restorable_sessions);
    if sessions.is_empty() {
        return vec![];
    }

    // Clear sessions so they don't restore again on next open (best-effort). Every other field,
    // `session_folders` included, is written back untouched.
    write_project_state(app_state, project_path, connection_key, &project_state).await;

    sessions
}

/// Spawn non-blocking session restores for a list of snapshots.
/// Returns immediately — each session loads in its own tokio task.
pub(crate) fn spawn_session_restores(
    app_state: Arc<AppState>,
    project_id: i32,
    snapshots: Vec<crate::project::models::SessionSnapshot>,
) {
    for snapshot in snapshots {
        let app_state = Arc::clone(&app_state);
        tokio::spawn(async move {
            let _ = crate::acp::session_handlers::restore_acp_session(
                &app_state,
                snapshot.agent_id,
                snapshot.acp_session_id,
                snapshot.cwd,
                snapshot.connection_key,
                snapshot.session_name,
                Some(project_id),
                snapshot.branch_name,
                snapshot.task_id,
            ).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::relative_to_project;

    /// The stored path has to survive the project moving, so it must come out relative — and a
    /// directory outside the project has no portable form at all and must be refused rather than
    /// stored as something that resolves elsewhere on the next machine.
    #[test]
    fn session_folders_are_stored_relative_to_the_project() {
        assert_eq!(relative_to_project("/home/me/proj", "/home/me/proj"), Some(String::new()));
        assert_eq!(
            relative_to_project("/home/me/proj/", "/home/me/proj/.maestro/worktrees/task-7"),
            Some(".maestro/worktrees/task-7".to_string())
        );
        assert_eq!(
            relative_to_project("C:\\dev\\proj", "C:\\dev\\proj\\.maestro\\worktrees\\task-7"),
            Some(".maestro/worktrees/task-7".to_string())
        );
        assert_eq!(relative_to_project("/home/me/proj", "/home/me/elsewhere"), None);
        assert_eq!(relative_to_project("/home/me/proj", "/home/me/proj-two"), None);
    }
}
