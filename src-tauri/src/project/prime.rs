use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::acp::ConnectionKey;
use super::session_state::{read_and_clear_restorable_sessions, spawn_session_restores};
#[cfg(windows)]
use rusqlite::params;

/// Pre-warm the shared maestro-server process for a project and optionally
/// pre-initialize the default agent so the first session spawn is near-instant.
///
/// The frontend should call this fire-and-forget after a successful `open_project`.
/// Failures are benign — subsequent session spawns fall back to the cold path.
///
/// Only applies to local (non-SSH) projects.
#[tauri::command]
#[specta::specta]
pub async fn prime_project_server(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let (project_path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?))),
        )
        .map_err(|_| format!("Project {} not found", project_id))?
    };

    // Each arm deploys and starts the connection's server, which is genuinely per-transport.
    // Everything after it — reading the project config, pre-initializing the default agent and
    // restoring sessions — is the same work on every connection and lives below the match.
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let ssh = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection_id {}", conn_id))?;

            let deploy_lock = {
                let mut locks = app_state.acp.deploy_locks.lock().await;
                locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
            };
            let _deploy_guard = deploy_lock.lock().await;
            let cached_path = {
                let cache = app_state.acp.discovery_cache.lock().await;
                cache.get(&ConnectionKey::Ssh { id: conn_id }).and_then(|e| e.maestro_server_path.clone())
            };
            let maestro_path = match cached_path {
                Some(p) => p,
                None => {
                    let deploy = crate::acp::deploy::ensure_remote_server(
                        &ssh, &app_state.app_handle, conn_id,
                    ).await?;
                    deploy.path
                }
            };

            crate::acp::spawn_connection_server(ConnectionKey::Ssh { id: conn_id }, crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path }, &app_state).await?;

            crate::acp::discovery_handlers::prefetch_agent_discovery(
                Arc::clone(&*app_state),
                ConnectionKey::Ssh { id: conn_id },
                Some(maestro_path),
            ).await;
        }

        ConnectionKey::Wsl { id: wsl_id } => {
            #[cfg(windows)]
            {
                let distro: String = {
                    let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    db.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        params![wsl_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| format!("WSL connection not found: {}", e))?
                };
                let maestro_path = crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle).await?.path;

                crate::acp::spawn_connection_server(
                    ConnectionKey::Wsl { id: wsl_id },
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &app_state,
                ).await?;

                crate::acp::discovery_handlers::prefetch_agent_discovery(
                    Arc::clone(&*app_state),
                    ConnectionKey::Wsl { id: wsl_id },
                    Some(maestro_path),
                ).await;
            }
            #[cfg(not(windows))]
            {
                let _ = wsl_id;
            }
        }

        ConnectionKey::Docker { id: docker_id } => {
            let container_name: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    rusqlite::params![docker_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Docker connection not found: {}", e))?
            };
            let cli = crate::connectivity::docker::ContainerCli::detect()
                .map_err(|e| format!("No container CLI found: {}", e))?;
            let maestro_path = crate::acp::deploy::ensure_container_server(&cli, &container_name, &app_state.app_handle).await?.path;

            crate::acp::spawn_connection_server(
                ConnectionKey::Docker { id: docker_id },
                crate::acp::TransportTarget::Docker { cli: &cli, container_name: &container_name, server_path: &maestro_path },
                &app_state,
            ).await?;

            crate::acp::discovery_handlers::prefetch_agent_discovery(
                Arc::clone(&*app_state),
                ConnectionKey::Docker { id: docker_id },
                Some(maestro_path),
            ).await;
        }

        ConnectionKey::Local => {
            crate::acp::spawn_connection_server(ConnectionKey::Local, crate::acp::TransportTarget::Local, &app_state).await?;
        }
    }

    // A config that cannot be read is a project with no default agent, not a failed prime: the
    // session restore below is the more valuable half and must still happen.
    let config = super::settings::load_project_config_for(&app_state, project_id)
        .await
        .unwrap_or_default();
    if let Some(agent_id) = config.default_agent {
        crate::acp::pre_initialize_via_connection_server(
            connection_key,
            &agent_id,
            &project_path,
            &app_state,
        )
        .await?;
    }

    let snapshots = read_and_clear_restorable_sessions(&app_state, &project_path, connection_key).await;
    spawn_session_restores(Arc::clone(&*app_state), project_id, snapshots);

    Ok(())
}
