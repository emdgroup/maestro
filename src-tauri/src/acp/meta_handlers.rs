use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::AppState;
use crate::acp::transport::{SessionDeleteRequest, SessionListRequest};
use crate::models::worktree::{ActiveSessionInfo, ExecutionMode, SessionListEntryDto, SessionListResult};

// Re-export attachment types and handlers (including macro-generated tauri/specta symbols)
// so ipc/mod.rs glob import still resolves them.
pub use crate::acp::attachment_handlers::*;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpSessionMeta {
    pub cwd: String,
    pub project_id: Option<i32>,
    pub session_start_sha: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_acp_session_meta(
    app_state: State<'_, Arc<AppState>>,
    session_key: i32,
) -> Result<AcpSessionMeta, String> {
    let (cwd, project_id, start_sha) = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions
            .get(&session_key)
            .ok_or_else(|| format!("No ACP session for key {}", session_key))?;
        (session.cwd.clone(), session.project_id, session.session_start_sha.clone())
    };

    // A rebase, amend or reset can leave the start commit unreachable, and `git diff <sha>`
    // then fails for the whole review panel. Report it as absent so the caller falls back to
    // an uncommitted-only diff, which it labels as such.
    let session_start_sha = match (start_sha, project_id) {
        (Some(sha), Some(project_id)) => {
            let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
            let rev = format!("{}^{{commit}}", sha);
            match crate::git::run_git_in_dir(&git_conn, &cwd, &["cat-file", "-e", &rev]).await {
                Ok(_) => Some(sha),
                Err(e) => {
                    log::warn!("Session {} start commit {} unreachable in {}: {}", session_key, sha, cwd, e);
                    None
                }
            }
        }
        (start_sha, _) => start_sha,
    };

    Ok(AcpSessionMeta { cwd, project_id, session_start_sha })
}

/// Branch currently checked out in the worktree containing `cwd`. The longest matching path wins:
/// Maestro's worktrees sit under the repo root, so a session inside one matches both.
fn branch_for_cwd(worktrees: &[crate::git::ParsedWorktree], cwd: &str) -> Option<String> {
    worktrees
        .iter()
        .filter(|wt| crate::git::worktree_lifecycle::path_is_within(cwd, &wt.path))
        .max_by_key(|wt| wt.path.len())
        .and_then(|wt| wt.branch.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn get_active_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ActiveSessionInfo>, String> {
    let mut sessions = Vec::new();
    let mut session_cwds: std::collections::HashMap<i32, String> = std::collections::HashMap::new();

    {
        let acp = app_state.acp.sessions.lock().await;
        for (key, proc) in acp.iter().filter(|(_, p)| p.project_id == Some(project_id)) {
            let native_id = proc.acp_session_id.lock().ok().and_then(|g| g.clone());
            session_cwds.insert(*key, proc.cwd.clone());
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: proc.session_name.clone(),
                agent_id: Some(proc.agent_id_meta.clone()),
                execution_mode: ExecutionMode::Acp,
                started_at: proc.started_at.clone(),
                task_id: proc.task_id,
                task_name: proc.task_name.clone(),
                branch_name: proc.branch_name.clone(),
                acp_session_id: native_id,
                supports_session_list: proc.session_capabilities.supports_session_list,
                supports_session_load: proc.session_capabilities.supports_session_load,
                supports_session_close: proc.session_capabilities.supports_session_close,
                supports_session_delete: proc.session_capabilities.supports_session_delete,
                project_id: Some(project_id),
                task_prevents_close: false,
            });
        }
    }

    // User-controlled PTY shells. These share the session list but are not ACP-managed agents.
    {
        let pty_meta = app_state.pty.session_meta.lock().await;
        for (key, meta) in pty_meta.iter() {
            if meta.project_id != Some(project_id) {
                continue;
            }
            session_cwds.insert(*key, meta.cwd.clone());
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: meta.session_name.clone(),
                agent_id: None,
                execution_mode: ExecutionMode::Pty,
                started_at: meta.started_at.clone(),
                task_id: meta.task_id,
                task_name: meta.task_name.clone(),
                branch_name: meta.branch_name.clone(),
                acp_session_id: None,
                supports_session_list: false,
                supports_session_load: false,
                supports_session_close: false,
                supports_session_delete: false,
                project_id: meta.project_id,
                task_prevents_close: false,
            });
        }
    }

    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at));

    // The branch recorded at spawn goes stale the moment anyone checks out inside the session's
    // directory, so read the current one from git. One `git worktree list` covers every session;
    // the longest matching path wins because Maestro's worktrees live inside the repo itself.
    if let Ok((_project, git_conn)) = crate::core::get_project_with_git_conn(&app_state, project_id).await {
        match crate::git::list_worktrees(&git_conn).await {
            Ok(worktrees) => {
                for session in &mut sessions {
                    let Some(cwd) = session_cwds.get(&session.session_key) else { continue };
                    if let Some(branch) = branch_for_cwd(&worktrees, cwd) {
                        session.branch_name = Some(branch);
                    }
                }
            }
            Err(e) => log::debug!("branch refresh skipped for project {}: {}", project_id, e),
        }
    }

    {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        for session in &mut sessions {
            if let Some(task_id) = session.task_id {
                let status: String = conn.query_row(
                    "SELECT status FROM tasks WHERE id = ?",
                    [task_id],
                    |row| row.get(0),
                ).unwrap_or_default();
                session.task_prevents_close = status == "InProgress" || status == "Review";
            }
        }
    }

    Ok(sessions)
}

#[tauri::command]
#[specta::specta]
pub async fn list_acp_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
    cursor: Option<String>,
) -> Result<SessionListResult, String> {
    let resp = crate::acp::query_session_list_via_server(
        connection,
        SessionListRequest { agent_id: agent_id.clone(), cwd: cwd.clone(), cursor },
        &app_state,
    )
    .await?;
    let supports_session_delete = resp.supports_session_delete;
    let (mut entries, next_cursor): (Vec<SessionListEntryDto>, Option<String>) = (
        resp.sessions.into_iter().map(|e| SessionListEntryDto {
            session_id: e.session_id,
            title: e.title,
            updated_at: e.updated_at,
            folder: None,
        }).collect(),
        resp.next_cursor,
    );

    // Folded in here rather than exposed as its own command: this handler already knows the
    // project, so the folder rides along on the reply the history modal is already waiting for.
    let project_location = {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                crate::acp::ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?),
            )),
        ).ok()
    };
    if let Some((project_path, project_connection)) = project_location {
        let folders = crate::project::session_state::read_project_state(
            &app_state,
            &project_path,
            project_connection,
        )
        .await
        .session_folders;
        for entry in &mut entries {
            entry.folder = folders
                .iter()
                .find(|f| f.agent_id == agent_id && f.acp_session_id == entry.session_id)
                .map(|f| f.relative_path.clone());
        }
    }

    let aliases = {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT acp_session_id, display_name FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2"
        ).map_err(|e| format!("DB prepare failed: {}", e))?;
        let map: std::collections::HashMap<String, String> = stmt
            .query_map(rusqlite::params![project_id, agent_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("DB query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        map
    };

    for entry in &mut entries {
        if let Some(alias) = aliases.get(&entry.session_id) {
            entry.title = Some(alias.clone());
        }
    }

    if next_cursor.is_none() && !aliases.is_empty() {
        let known_ids: Vec<String> = entries.iter().map(|e| e.session_id.clone()).collect();
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        if !known_ids.is_empty() {
            let placeholders = (0..known_ids.len())
                .map(|i| format!("?{}", i + 3))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "DELETE FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2 AND acp_session_id NOT IN ({})",
                placeholders
            );
            let mut params: Vec<rusqlite::types::Value> = vec![
                rusqlite::types::Value::Integer(project_id as i64),
                rusqlite::types::Value::Text(agent_id.clone()),
            ];
            for id in &known_ids {
                params.push(rusqlite::types::Value::Text(id.clone()));
            }
            conn.execute(&sql, rusqlite::params_from_iter(params))
                .map_err(|e| format!("Prune aliases failed: {}", e))?;
        } else {
            conn.execute(
                "DELETE FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2",
                rusqlite::params![project_id, agent_id],
            ).map_err(|e| format!("Prune aliases failed: {}", e))?;
        }
    }

    Ok(SessionListResult { sessions: entries, supports_session_delete })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    session_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    crate::acp::query_session_delete_via_server(
        connection,
        SessionDeleteRequest { agent_id, session_id, cwd },
        &app_state,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_acp_session(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
    acp_session_id: String,
    display_name: String,
) -> Result<(), String> {
    {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        crate::acp::manager::upsert_session_alias(&conn, project_id, &agent_id, &acp_session_id, &display_name)
            .map_err(|e| format!("Upsert alias failed: {}", e))?;
    }

    {
        let mut sessions = app_state.acp.sessions.lock().await;
        for proc in sessions.values_mut() {
            let matches = proc.acp_session_id.lock()
                .map(|g| g.as_deref() == Some(&acp_session_id))
                .unwrap_or(false);
            if matches {
                proc.session_name = Some(display_name.clone());
                break;
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

/// Re-emit model/mode state from session fields during replay drain.
async fn emit_init_events_from_session(log_id: i32, app_state: &Arc<AppState>) {
    let (model_id, mode_id, config_options) = {
        let sessions = app_state.acp.sessions.lock().await;
        let Some(session) = sessions.get(&log_id) else { return };
        (
            session.current_model_id.lock().ok().and_then(|m| m.clone()),
            session.current_mode_id.lock().ok().and_then(|m| m.clone()),
            session.config_options.clone(),
        )
    };

    let find_opt = |id: &str| -> Option<&serde_json::Value> {
        config_options.iter().find(|o| o.get("id").and_then(|v| v.as_str()) == Some(id))
    };

    if let Some(model_opt) = find_opt("model") {
        let options = model_opt.get("options").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        let current = model_id.unwrap_or_else(|| {
            options.first().and_then(|v| v.get("value")).and_then(|v| v.as_str()).unwrap_or("").to_string()
        });
        let payload = serde_json::json!({
            "current_model_id": current,
            "available_models": options.iter().map(|v| serde_json::json!({
                "model_id": v.get("value").and_then(|s| s.as_str()).unwrap_or(""),
                "name": v.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-models/{}", log_id), &payload);
    }
    if let Some(mode_opt) = find_opt("mode") {
        let options = mode_opt.get("options").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        let current = mode_id.unwrap_or_else(|| {
            options.first().and_then(|v| v.get("value")).and_then(|v| v.as_str()).unwrap_or("").to_string()
        });
        let payload = serde_json::json!({
            "current_mode_id": current,
            "available_modes": options.iter().map(|v| serde_json::json!({
                "mode_id": v.get("value").and_then(|s| s.as_str()).unwrap_or(""),
                "name": v.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-modes/{}", log_id), &payload);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn drain_acp_replay(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    let replay_arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .get(&log_id)
            .map(|s| Arc::clone(&s.replay_buffer))
    };
    let Some(replay_arc) = replay_arc else {
        return Ok(());
    };
    let buffered = {
        let mut buf = replay_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        buf.take()
    };
    let is_initialized = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id)
            .and_then(|s| s.initialized.lock().ok().map(|g| *g))
            .unwrap_or(false)
    };
    if let Some(events) = buffered {
        for payload in events {
            let _ = app_state.app_handle.emit(&format!("acp://session-update/{}", log_id), &payload);
        }
        if is_initialized {
            emit_init_events_from_session(log_id, &app_state).await;
            let _ = app_state.app_handle.emit(&format!("acp://replay-drained/{}", log_id), ());
        }
    } else if is_initialized {
        // Buffer already consumed (no replay buffer for new sessions, or drained before
        // panel mounted). Emit replay-drained so late-mounting panels complete
        // initialization instead of waiting for the 15 s stale timeout.
        emit_init_events_from_session(log_id, &app_state).await;
        let _ = app_state.app_handle.emit(&format!("acp://replay-drained/{}", log_id), ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::branch_for_cwd;
    use crate::git::ParsedWorktree;

    fn worktree(path: &str, branch: &str) -> ParsedWorktree {
        ParsedWorktree {
            path: path.to_string(),
            branch: Some(branch.to_string()),
            head: String::new(),
            is_prunable: false,
        }
    }

    #[test]
    fn session_takes_the_branch_of_its_own_worktree_not_the_repo_root() {
        let worktrees = vec![
            worktree("/repo", "main"),
            worktree("/repo/.maestro/worktrees/session-3", "maestro/lucky-fern"),
        ];
        assert_eq!(
            branch_for_cwd(&worktrees, "/repo/.maestro/worktrees/session-3/src").as_deref(),
            Some("maestro/lucky-fern"),
        );
        assert_eq!(branch_for_cwd(&worktrees, "/repo").as_deref(), Some("main"));
        assert_eq!(branch_for_cwd(&worktrees, "/elsewhere"), None);
    }
}
