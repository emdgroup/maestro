use std::sync::Arc;
use rusqlite::params;
use crate::core::AppState;
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;
use crate::command_ext::NoConsoleWindow;

/// Write the current live sessions for a project to `.maestro/state.json`.
/// Called fire-and-forget via tokio::spawn after session spawn/cancel.
/// No-ops if `reopen_sessions` is not enabled for this project.
pub async fn save_current_sessions_for_project(app_state: Arc<AppState>, project_id: i32) {
    if app_state.is_closing.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let enabled = app_state.acp.reopen_sessions.lock().await
        .get(&project_id).copied().unwrap_or(false);
    if !enabled {
        return;
    }

    let (project_path, connection_key) = {
        match app_state.db.lock() {
            Ok(conn) => match conn.query_row(
                "SELECT path, connection_id, wsl_connection_id FROM projects WHERE id = ?",
                [project_id],
                |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_ids(row.get(1)?, row.get(2)?))),
            ) {
                Ok(row) => row,
                Err(_) => return,
            },
            Err(_) => return,
        }
    };

    let snapshots: Vec<crate::project::models::SessionSnapshot> = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.values()
            .filter(|proc| proc.project_id == Some(project_id))
            .filter_map(|proc| {
                let acp_session_id = proc.acp_session_id.lock().ok()?.clone()?;
                Some(crate::project::models::SessionSnapshot {
                    agent_id: proc.agent_id_meta.clone(),
                    acp_session_id,
                    cwd: proc.cwd.clone(),
                    session_name: proc.session_name.clone(),
                    connection_key: proc.connection_key,
                    branch_name: proc.branch_name.clone(),
                })
            })
            .collect()
    };

    let project_state = crate::project::models::ProjectState {
        restorable_sessions: snapshots,
        ..Default::default()
    };
    let json = match serde_json::to_string_pretty(&project_state) {
        Ok(j) => j,
        Err(_) => return,
    };

    let state_path = format!("{}/.maestro/state.json", project_path);
    let maestro_dir = format!("{}/.maestro", project_path);

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            if let Some(session) = app_state.ssh.get_session(conn_id).await {
                session.execute_command(&format!(
                    "mkdir -p {} && printf '%s' {} > {}",
                    shell_quote(&maestro_dir),
                    shell_quote(&json),
                    shell_quote(&state_path),
                )).await.ok();
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: Option<String> = app_state.db.lock().ok().and_then(|db| {
                db.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    params![wsl_id],
                    |row| row.get(0),
                ).ok()
            });
            if let Some(distro) = distro {
                let script = format!(
                    "mkdir -p {} && printf '%s' {} > {}",
                    shell_quote(&maestro_dir),
                    shell_quote(&json),
                    shell_quote(&state_path),
                );
                tokio::process::Command::new("wsl.exe")
                    .args(["-d", &distro, "--", "sh", "-c", &script])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_console_window()
                    .output()
                    .await
                    .ok();
            }
        }
        ConnectionKey::Local => {
            project_state.save_to_project(&project_path).ok();
        }
    }
}

pub(crate) async fn delete_state_json_for_project(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) {
    let state_path = format!("{}/.maestro/state.json", project_path);
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            if let Some(session) = app_state.ssh.get_session(conn_id).await {
                session.execute_command(&format!("rm -f {}", shell_quote(&state_path))).await.ok();
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: Option<String> = app_state.db.lock().ok().and_then(|db| {
                db.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    params![wsl_id],
                    |row| row.get(0),
                ).ok()
            });
            if let Some(distro) = distro {
                tokio::process::Command::new("wsl.exe")
                    .args(["-d", &distro, "--", "rm", "-f", &state_path])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_console_window()
                    .output()
                    .await
                    .ok();
            }
        }
        ConnectionKey::Local => {
            match std::fs::remove_file(&state_path) {
                Ok(()) | Err(_) => {}
            }
        }
    }
}

/// Read `.maestro/state.json` for a project, extract restorable sessions, and save back cleared state.
/// Returns an empty vec if state.json is missing, unreadable, or has no sessions.
pub(crate) async fn read_and_clear_restorable_sessions(
    app_state: &Arc<AppState>,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Vec<crate::project::models::SessionSnapshot> {
    let state_path = format!("{}/.maestro/state.json", project_path);
    let maestro_dir = format!("{}/.maestro", project_path);

    let mut project_state: crate::project::models::ProjectState = match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = match app_state.ssh.get_session(conn_id).await {
                Some(s) => s,
                None => return vec![],
            };
            match session.execute_command(&format!("cat {}", shell_quote(&state_path))).await {
                Ok(output) => serde_json::from_str(&output).unwrap_or_default(),
                Err(_) => return vec![],
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = match app_state.db.lock() {
                Ok(db) => match db.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    params![wsl_id],
                    |row| row.get(0),
                ) {
                    Ok(d) => d,
                    Err(_) => return vec![],
                },
                Err(_) => return vec![],
            };
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "cat", &state_path])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await;
            match output {
                Ok(out) if out.status.success() => {
                    let text = String::from_utf8_lossy(&out.stdout);
                    serde_json::from_str(&text).unwrap_or_default()
                }
                _ => return vec![],
            }
        }
        ConnectionKey::Local => {
            crate::project::models::ProjectState::load_from_project(project_path).unwrap_or_default()
        }
    };

    let sessions = std::mem::take(&mut project_state.restorable_sessions);
    if sessions.is_empty() {
        return vec![];
    }

    // Clear sessions so they don't restore again on next open (best-effort).
    let json = match serde_json::to_string_pretty(&project_state) {
        Ok(j) => j,
        Err(_) => return sessions,
    };
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            if let Some(session) = app_state.ssh.get_session(conn_id).await {
                let _ = session.execute_command(&format!(
                    "mkdir -p {} && printf '%s' {} > {}",
                    shell_quote(&maestro_dir),
                    shell_quote(&json),
                    shell_quote(&state_path),
                )).await;
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: Option<String> = app_state.db.lock().ok().and_then(|db| {
                db.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    params![wsl_id],
                    |row| row.get(0),
                ).ok()
            });
            if let Some(distro) = distro {
                let script = format!(
                    "mkdir -p {} && printf '%s' {} > {}",
                    shell_quote(&maestro_dir),
                    shell_quote(&json),
                    shell_quote(&state_path),
                );
                let _ = tokio::process::Command::new("wsl.exe")
                    .args(["-d", &distro, "--", "sh", "-c", &script])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_console_window()
                    .output()
                    .await;
            }
        }
        ConnectionKey::Local => {
            let _ = project_state.save_to_project(project_path);
        }
    }

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
            ).await;
        });
    }
}
