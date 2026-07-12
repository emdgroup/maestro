use std::sync::Arc;
use std::time::Duration;
use std::collections::HashSet;
use tauri::State;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::AppState;
use crate::acp::ConnectionKey;
use crate::acp::registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry, ProjectAgentMatch};
use crate::acp::transport::CheckToolsResponse;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreflightCheck {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ToolCheckEntry {
    pub tool: String,
    pub available: bool,
    pub version: Option<String>,
    pub required_by: Vec<String>,
    pub mandatory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreflightResult {
    pub maestro_server: PreflightCheck,
    pub agents: Vec<DiscoveredAgent>,
    pub tool_checks: Vec<ToolCheckEntry>,
}

/// Validate the environment for a connection and boot the persistent server.
#[tauri::command]
#[specta::specta]
pub async fn preflight_connection(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
) -> Result<PreflightResult, String> {
    let connection_key = connection;
    let server_already_running = app_state
        .acp
        .connection_servers
        .lock()
        .await
        .contains_key(&connection_key);

    if !server_already_running {
        match &connection_key {
            ConnectionKey::Ssh { id: conn_id } => {
                let conn_id = *conn_id;
                let ssh = app_state
                    .ssh
                    .get_session(conn_id)
                    .await
                    .ok_or_else(|| {
                        format!("No active SSH session for connection_id {}. Connect first.", conn_id)
                    })?;
                let deploy_lock = {
                    let mut locks = app_state.acp.deploy_locks.lock().await;
                    locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
                };
                let _deploy_guard = deploy_lock.lock().await;
                let cached_path = app_state
                    .acp
                    .discovery_cache
                    .lock()
                    .await
                    .get(&ConnectionKey::Ssh { id: conn_id })
                    .and_then(|e| e.maestro_server_path.clone());
                let maestro_path = match cached_path {
                    Some(p) => p,
                    None => {
                        let deploy = crate::acp::deploy::ensure_remote_server(
                            &ssh,
                            &app_state.app_handle,
                            conn_id,
                        )
                        .await
                        .map_err(|e| format!("Failed to deploy maestro-server: {}", e))?;
                        let path = deploy.path.clone();
                        app_state
                            .acp
                            .discovery_cache
                            .lock()
                            .await
                            .entry(ConnectionKey::Ssh { id: conn_id })
                            .or_insert_with(|| AgentDiscoveryCacheEntry {
                                result: AgentDiscoveryResult {
                                    maestro_server_available: true,
                                    agents: Vec::new(),
                                    error: None,
                                },
                                maestro_server_path: None,
                                fetched_at: std::time::Instant::now(),
                            })
                            .maestro_server_path = Some(path.clone());
                        path
                    }
                };
                crate::acp::spawn_connection_server(
                    ConnectionKey::Ssh { id: conn_id },
                    crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
            ConnectionKey::Wsl { id: wsl_id } => {
                let wsl_id = *wsl_id;
                let distro = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        [wsl_id],
                        |row| row.get::<_, String>(0),
                    ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
                };
                #[cfg(windows)]
                {
                    let cached_path = app_state
                        .acp
                        .discovery_cache
                        .lock()
                        .await
                        .get(&connection_key)
                        .and_then(|e| e.maestro_server_path.clone());
                    let maestro_path = match cached_path {
                        Some(p) => p,
                        None => {
                            let deploy = crate::acp::deploy::ensure_wsl_server(
                                &distro,
                                &app_state.app_handle,
                            )
                            .await
                            .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?;
                            deploy.path
                        }
                    };
                    crate::acp::spawn_connection_server(
                        connection_key,
                        crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                        &app_state,
                    )
                    .await
                    .map_err(|e| format!("Failed to start WSL maestro-server: {}", e))?;
                }
                #[cfg(not(windows))]
                {
                    let _ = distro;
                    return Err("WSL connections are only supported on Windows".to_string());
                }
            }
            ConnectionKey::Local => {
                crate::acp::deploy::ensure_local_server(&app_state.app_handle)
                    .await
                    .map_err(|e| format!("maestro-server not available: {}", e))?;
                crate::acp::spawn_connection_server(
                    ConnectionKey::Local,
                    crate::acp::TransportTarget::Local,
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
            ConnectionKey::Docker { id: docker_id } => {
                let docker_id = *docker_id;
                let container_name = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT container_name FROM docker_connections WHERE id = ?",
                        [docker_id],
                        |row| row.get::<_, String>(0),
                    ).map_err(|e| format!("Docker connection {} not found: {}", docker_id, e))?
                };
                let cli = crate::connectivity::docker::ContainerCli::detect()
                    .map_err(|e| format!("No container CLI found: {}", e))?;
                let cached_path = app_state
                    .acp
                    .discovery_cache
                    .lock()
                    .await
                    .get(&connection_key)
                    .and_then(|e| e.maestro_server_path.clone());
                let maestro_path = match cached_path {
                    Some(p) => p,
                    None => crate::acp::deploy::ensure_container_server(&cli, &container_name, &app_state.app_handle)
                        .await
                        .map_err(|e| format!("Failed to deploy maestro-server to container: {}", e))?
                        .path,
                };
                crate::acp::spawn_connection_server(
                    connection_key,
                    crate::acp::TransportTarget::Docker { cli: &cli, container_name: &container_name, server_path: &maestro_path },
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start container maestro-server: {}", e))?;
            }
        }
    }

    let (agents, _) = fetch_and_filter_agents(connection_key, &app_state).await;

    let mut tools_to_check: Vec<String> = agents
        .iter()
        .flat_map(|a| a.spawn_deps.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !tools_to_check.iter().any(|t| t == "git") {
        tools_to_check.push("git".to_string());
    }

    let tool_results = crate::acp::query_check_tools_via_server(connection_key, tools_to_check, &app_state)
        .await
        .unwrap_or_else(|_| CheckToolsResponse { results: Vec::new() });

    let mandatory_tools: HashSet<&str> = ["git"].into();
    let tool_checks: Vec<ToolCheckEntry> = tool_results
        .results
        .into_iter()
        .map(|r| {
            let required_by: Vec<String> = agents
                .iter()
                .filter(|a| a.spawn_deps.contains(&r.tool))
                .map(|a| a.id.clone())
                .collect();
            crate::acp::manager::append_debug_log(&format!(
                "[preflight] tool={} available={} version={:?}",
                r.tool, r.available, r.version
            ));
            ToolCheckEntry {
                mandatory: mandatory_tools.contains(r.tool.as_str()),
                tool: r.tool,
                available: r.available,
                version: r.version,
                required_by,
            }
        })
        .collect();

    {
        let mut cache = app_state.acp.discovery_cache.lock().await;
        let maestro_server_path = cache.get(&connection_key).and_then(|e| e.maestro_server_path.clone());
        cache.insert(connection_key, AgentDiscoveryCacheEntry {
            result: AgentDiscoveryResult {
                maestro_server_available: true,
                agents: agents.clone(),
                error: None,
            },
            maestro_server_path,
            fetched_at: std::time::Instant::now(),
        });
    }

    Ok(PreflightResult {
        maestro_server: PreflightCheck { ok: true, message: None },
        agents,
        tool_checks,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn detect_project_agents(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
    cwd: String,
) -> Result<Vec<ProjectAgentMatch>, String> {
    let response = crate::acp::manager::query_detect_project_agents_via_server(
        connection,
        cwd,
        &app_state,
    )
    .await?;

    Ok(response
        .agents
        .into_iter()
        .map(|a| ProjectAgentMatch {
            agent_id: a.agent_id,
            markers_found: a.markers_found,
        })
        .collect())
}

pub(crate) async fn fetch_and_filter_agents(
    connection_key: ConnectionKey,
    app_state: &Arc<AppState>,
) -> (Vec<DiscoveredAgent>, Option<String>) {
    let result = crate::acp::query_list_agents_via_connection_server(connection_key, app_state).await;
    let (all_agents, list_error) = match result {
        Ok(a) => (a, None),
        Err(e) => return (Vec::new(), Some(e)),
    };

    let detected = crate::acp::manager::query_detect_installed_via_server(connection_key, app_state)
        .await
        .unwrap_or_else(|_| maestro_protocol::DetectInstalledAgentsResponse {
            agents: Vec::new(),
            all_checked_ids: Vec::new(),
        });

    let detected_tool_names: std::collections::HashMap<String, String> = detected
        .agents.iter().map(|d| (d.agent_id.clone(), d.tool_name.clone())).collect();
    let detected_ids: HashSet<String> = detected.agents.iter().map(|d| d.agent_id.clone()).collect();

    let agents: Vec<DiscoveredAgent> = all_agents.into_iter()
        .filter(|a| detected_ids.contains(&a.id))
        .map(|mut a| {
            if let Some(tool_name) = detected_tool_names.get(&a.id) {
                a.name = tool_name.clone();
            }
            a
        })
        .collect();

    crate::acp::manager::append_debug_log(&format!(
        "[preflight] agents after filter: {:?}",
        agents.iter().map(|a| &a.id).collect::<Vec<_>>()
    ));

    (agents, list_error)
}

pub async fn prefetch_agent_discovery(
    app_state: Arc<AppState>,
    connection_key: ConnectionKey,
    known_maestro_path: Option<String>,
) {
    {
        let cache = app_state.acp.discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_key) {
            if !entry.result.agents.is_empty() {
                return;
            }
        }
    }
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let conn_key = ConnectionKey::Ssh { id: conn_id };
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&conn_key);
            if has_connection_server {
                let maestro_path = known_maestro_path.or_else(|| {
                    let cache = app_state.acp.discovery_cache.try_lock().ok();
                    cache.and_then(|c| c.get(&conn_key).and_then(|e| e.maestro_server_path.clone()))
                });
                let (agents, error) = fetch_and_filter_agents(conn_key, &app_state).await;
                let maestro_server_available = error.is_none();
                let entry = AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: maestro_path,
                    fetched_at: std::time::Instant::now(),
                };
                app_state.acp.discovery_cache.lock().await.insert(conn_key, entry);
                return;
            }

            let Some(ssh) = app_state.ssh.get_session(conn_id).await else {
                return;
            };
            let maestro_path = if let Some(p) = known_maestro_path {
                Some(p)
            } else {
                let deploy_lock = {
                    let mut locks = app_state.acp.deploy_locks.lock().await;
                    locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
                };
                let _deploy_guard = deploy_lock.lock().await;
                let cached = app_state.acp.discovery_cache.lock().await
                    .get(&conn_key)
                    .and_then(|e| e.maestro_server_path.clone());
                if let Some(p) = cached {
                    Some(p)
                } else {
                    crate::acp::deploy::ensure_remote_server(&ssh, &app_state.app_handle, conn_id)
                        .await
                        .ok()
                        .map(|r| r.path)
                }
            };
            let Some(path) = maestro_path else {
                app_state.acp.discovery_cache.lock().await.insert(conn_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            };
            if crate::acp::spawn_connection_server(
                conn_key,
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &path },
                &app_state,
            ).await.is_err() {
                return;
            }
            let (agents, error) = fetch_and_filter_agents(conn_key, &app_state).await;
            let maestro_server_available = error.is_none();
            app_state.acp.discovery_cache.lock().await.insert(conn_key, AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: Some(path),
                fetched_at: std::time::Instant::now(),
            });
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let wsl_key = ConnectionKey::Wsl { id: wsl_id };
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&wsl_key);
            if has_connection_server {
                let (agents, error) = fetch_and_filter_agents(wsl_key, &app_state).await;
                let maestro_server_available = error.is_none();
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            let distro = {
                let Ok(conn) = app_state.db.lock() else { return };
                match conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ) {
                    Ok(d) => d,
                    Err(_) => return,
                }
            };
            #[cfg(windows)]
            {
                let maestro_path = match crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle).await {
                    Ok(r) => r.path,
                    Err(_) => {
                        app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                            result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                            maestro_server_path: None,
                            fetched_at: std::time::Instant::now(),
                        });
                        return;
                    }
                };
                if crate::acp::spawn_connection_server(
                    wsl_key,
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &app_state,
                ).await.is_err() {
                    return;
                }
                let (agents, error) = fetch_and_filter_agents(wsl_key, &app_state).await;
                let maestro_server_available = error.is_none();
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: Some(maestro_path),
                    fetched_at: std::time::Instant::now(),
                });
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
            }
        }
        ConnectionKey::Local => {
            let server_path = crate::acp::deploy::ensure_local_server(&app_state.app_handle).await;
            if server_path.is_err() {
                app_state.acp.discovery_cache.lock().await.insert(ConnectionKey::Local, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            if crate::acp::spawn_connection_server(ConnectionKey::Local, crate::acp::TransportTarget::Local, &app_state)
                .await.is_err() {
                return;
            }
            let (agents, error) = fetch_and_filter_agents(ConnectionKey::Local, &app_state).await;
            app_state.acp.discovery_cache.lock().await.insert(ConnectionKey::Local, AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available: true, agents, error },
                maestro_server_path: None,
                fetched_at: std::time::Instant::now(),
            });
        }
        ConnectionKey::Docker { id: docker_id } => {
            let docker_key = ConnectionKey::Docker { id: docker_id };
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&docker_key);
            if has_connection_server {
                let (agents, error) = fetch_and_filter_agents(docker_key, &app_state).await;
                let maestro_server_available = error.is_none();
                app_state.acp.discovery_cache.lock().await.insert(docker_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            let container_name = {
                let Ok(conn) = app_state.db.lock() else { return };
                match conn.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    [docker_id],
                    |row| row.get::<_, String>(0),
                ) {
                    Ok(name) => name,
                    Err(_) => return,
                }
            };
            let cli = match crate::connectivity::docker::ContainerCli::detect() {
                Ok(c) => c,
                Err(_) => {
                    app_state.acp.discovery_cache.lock().await.insert(docker_key, AgentDiscoveryCacheEntry {
                        result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                        maestro_server_path: None,
                        fetched_at: std::time::Instant::now(),
                    });
                    return;
                }
            };
            let maestro_path = match crate::acp::deploy::ensure_container_server(&cli, &container_name, &app_state.app_handle).await {
                Ok(r) => r.path,
                Err(_) => {
                    app_state.acp.discovery_cache.lock().await.insert(docker_key, AgentDiscoveryCacheEntry {
                        result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                        maestro_server_path: None,
                        fetched_at: std::time::Instant::now(),
                    });
                    return;
                }
            };
            if crate::acp::spawn_connection_server(
                docker_key,
                crate::acp::TransportTarget::Docker { cli: &cli, container_name: &container_name, server_path: &maestro_path },
                &app_state,
            ).await.is_err() {
                return;
            }
            let (agents, error) = fetch_and_filter_agents(docker_key, &app_state).await;
            let maestro_server_available = error.is_none();
            app_state.acp.discovery_cache.lock().await.insert(docker_key, AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: Some(maestro_path),
                fetched_at: std::time::Instant::now(),
            });
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn discover_agents(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
) -> Result<AgentDiscoveryResult, String> {
    let connection_key = connection;
    {
        let cache = app_state.acp.discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_key) {
            if entry.fetched_at.elapsed() < Duration::from_secs(300) {
                return Ok(entry.result.clone());
            }
        }
    }

    let arc = Arc::clone(app_state.inner());
    prefetch_agent_discovery(arc, connection_key, None).await;

    app_state.acp.discovery_cache.lock().await
        .get(&connection_key)
        .map(|e| e.result.clone())
        .ok_or_else(|| match connection_key {
            ConnectionKey::Local => "Local agent discovery failed — is maestro-server installed?".to_string(),
            ConnectionKey::Ssh { id } => format!("No active SSH session for connection_id {}. Connect first.", id),
            ConnectionKey::Wsl { id } => format!("WSL discovery failed for wsl_connection_id {}.", id),
            ConnectionKey::Docker { id } => format!("Container discovery failed for docker_connection_id {}.", id),
        })
}
