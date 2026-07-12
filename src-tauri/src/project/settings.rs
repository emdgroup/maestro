use std::sync::Arc;
use tauri::State;
use rusqlite::params;
use chrono::Utc;
use crate::core::AppState;
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;
use crate::command_ext::NoConsoleWindow;

/// Get project-level configuration from .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn get_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    let (path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?))),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let settings_path = format!("{}/.maestro/settings.json", path);
    let config = match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            match session.execute_command(&format!("cat {}", shell_quote(&settings_path))).await {
                Ok(output) => serde_json::from_str::<crate::models::ProjectConfig>(&output).unwrap_or_default(),
                Err(_) => crate::models::ProjectConfig::default(),
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "cat", &settings_path])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                serde_json::from_str::<crate::models::ProjectConfig>(&text).unwrap_or_default()
            } else {
                crate::models::ProjectConfig::default()
            }
        }
        ConnectionKey::Docker { id: docker_id } => {
            let container_name: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT container_name FROM docker_connections WHERE id = ?", params![docker_id], |row| row.get(0))
                    .map_err(|e| format!("Docker connection not found: {}", e))?
            };
            let cli = crate::connectivity::docker::ContainerCli::detect().unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
            match crate::connectivity::docker::read_file(&cli, &container_name, &settings_path) {
                Ok(text) => serde_json::from_str::<crate::models::ProjectConfig>(&text).unwrap_or_default(),
                Err(_) => crate::models::ProjectConfig::default(),
            }
        }
        ConnectionKey::Local => {
            crate::models::ProjectConfig::load_from_project(&path).unwrap_or_default()
        }
    };

    Ok(crate::models::ProjectConfigResponse {
        default_agent: config.default_agent,
        reopen_sessions: config.reopen_sessions,
        startup_tab: config.startup_tab,
    })
}

/// Update project-level configuration in .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn update_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    let (path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?))),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let maestro_dir = format!("{}/.maestro", path);
    let settings_path = format!("{}/settings.json", maestro_dir);

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            // Load existing config to preserve fields managed by other handlers (e.g. issue_tracking).
            let mut config = match session.execute_command(&format!("cat {}", shell_quote(&settings_path))).await {
                Ok(output) => serde_json::from_str::<crate::models::ProjectConfig>(&output).unwrap_or_default(),
                Err(_) => crate::models::ProjectConfig::default(),
            };
            config.default_agent = settings.default_agent;
            config.reopen_sessions = settings.reopen_sessions;
            config.startup_tab = settings.startup_tab;
            config.updated_at = Utc::now().to_rfc3339();
            let json = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Serialization failed: {}", e))?;
            session.execute_command(&format!(
                "mkdir -p {} && printf '%s' {} > {}",
                shell_quote(&maestro_dir),
                shell_quote(&json),
                shell_quote(&settings_path),
            )).await.map_err(|e| format!("SSH write failed: {}", e))?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            // Load existing config to preserve fields managed by other handlers.
            let mut config = {
                let read_output = tokio::process::Command::new("wsl.exe")
                    .args(["-d", &distro, "--", "cat", &settings_path])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_console_window()
                    .output()
                    .await
                    .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
                if read_output.status.success() {
                    let text = String::from_utf8_lossy(&read_output.stdout);
                    serde_json::from_str::<crate::models::ProjectConfig>(&text).unwrap_or_default()
                } else {
                    crate::models::ProjectConfig::default()
                }
            };
            config.default_agent = settings.default_agent;
            config.reopen_sessions = settings.reopen_sessions;
            config.startup_tab = settings.startup_tab;
            config.updated_at = Utc::now().to_rfc3339();
            let json = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Serialization failed: {}", e))?;
            let script = format!(
                "mkdir -p {} && printf '%s' {} > {}",
                shell_quote(&maestro_dir),
                shell_quote(&json),
                shell_quote(&settings_path),
            );
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "sh", "-c", &script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if !output.status.success() {
                return Err(format!("WSL settings write failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
        ConnectionKey::Docker { id: docker_id } => {
            let container_name: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT container_name FROM docker_connections WHERE id = ?", params![docker_id], |row| row.get(0))
                    .map_err(|e| format!("Docker connection not found: {}", e))?
            };
            let cli = crate::connectivity::docker::ContainerCli::detect().unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
            let mut config = match crate::connectivity::docker::read_file(&cli, &container_name, &settings_path) {
                Ok(text) => serde_json::from_str::<crate::models::ProjectConfig>(&text).unwrap_or_default(),
                Err(_) => crate::models::ProjectConfig::default(),
            };
            config.default_agent = settings.default_agent;
            config.reopen_sessions = settings.reopen_sessions;
            config.startup_tab = settings.startup_tab;
            config.updated_at = Utc::now().to_rfc3339();
            let json = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Serialization failed: {}", e))?;
            let script = format!(
                "mkdir -p {} && printf '%s' {} > {}",
                shell_quote(&maestro_dir),
                shell_quote(&json),
                shell_quote(&settings_path),
            );
            let output = tokio::process::Command::new(cli.binary())
                .args(["exec", &container_name, "sh", "-c", &script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
                .map_err(|e| format!("Failed to exec into container: {}", e))?;
            if !output.status.success() {
                return Err(format!("Docker settings write failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
        ConnectionKey::Local => {
            // Load-modify-save to preserve fields managed by other handlers (e.g. issue_tracking).
            let mut config = crate::models::ProjectConfig::load_from_project(&path).unwrap_or_default();
            config.default_agent = settings.default_agent;
            config.reopen_sessions = settings.reopen_sessions;
            config.startup_tab = settings.startup_tab;
            config.updated_at = Utc::now().to_rfc3339();
            config.save_to_project(&path)?;
        }
    }

    app_state.acp.reopen_sessions.lock().await
        .insert(project_id, settings.reopen_sessions.unwrap_or(false));

    Ok(())
}
