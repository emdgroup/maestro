use std::sync::Arc;
use tauri::State;
use rusqlite::params;
use crate::core::AppState;
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;
use crate::command_ext::NoConsoleWindow;
use super::crud::register_project_in_db;

/// Initialize git in an existing directory (no-op if already a git repo)
#[tauri::command]
#[specta::specta]
pub async fn git_init_project(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<(), String> {
    if let Some(conn_id) = connection_id {
        let session = app_state
            .ssh.get_session(conn_id)
            .await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        // No-op if already a git repo
        let check = session
            .execute_command(&format!("test -d {}/.git && echo yes || echo no", shell_quote(&path)))
            .await
            .map_err(|e| format!("SSH check failed: {}", e))?;
        if check.trim() == "yes" {
            return Ok(());
        }
        let output = session
            .execute_command(&format!("git init -b main {}", shell_quote(&path)))
            .await
            .map_err(|e| format!("SSH git init failed: {}", e))?;
        if output.contains("Initialized") || output.contains("Reinitialized") {
            return Ok(());
        }
        return Err(format!("git init failed: {}", output));
    }

    if let Some(wsl_id) = wsl_connection_id {
        let distro: String = {
            let db = app_state.db.lock().map_err(|e| e.to_string())?;
            db.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                params![wsl_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("WSL connection not found: {}", e))?
        };
        // No-op if already a git repo
        let check = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "-C", &path, "rev-parse", "--is-inside-work-tree"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        if check.status.success() {
            return Ok(());
        }
        let output = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "init", "-b", "main", &path])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let git_dir = std::path::Path::new(&path).join(".git");
    if git_dir.exists() {
        return Ok(());
    }
    let output = tokio::process::Command::new("git")
        .args(["init", "-b", "main", &path])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_is_git_repo(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<bool, String> {
    if let Some(conn_id) = connection_id {
        let session = app_state
            .ssh.get_session(conn_id)
            .await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let check = session
            .execute_command(&format!(
                "git -C {} rev-parse --is-inside-work-tree 2>/dev/null && echo yes || echo no",
                shell_quote(&path)
            ))
            .await
            .map_err(|e| format!("SSH check failed: {}", e))?;
        return Ok(check.trim().ends_with("yes"));
    }

    if let Some(wsl_id) = wsl_connection_id {
        let distro: String = {
            let db = app_state.db.lock().map_err(|e| e.to_string())?;
            db.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                params![wsl_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("WSL connection not found: {}", e))?
        };
        let output = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "-C", &path, "rev-parse", "--is-inside-work-tree"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        return Ok(output.status.success());
    }

    // Use `git rev-parse` to detect both root repos and subdirectories within a git tree
    let output = tokio::process::Command::new("git")
        .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_console_window()
        .output()
        .await;
    match output {
        Ok(out) => Ok(out.status.success()),
        Err(_) => Ok(false), // git not installed → not a git repo
    }
}

async fn build_provider_auth_header(
    provider: &str,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    // GitHub supports a fallback to the `gh` CLI token when no keychain entry exists.
    let token_result = if provider == "github" {
        match crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state) {
            Ok(creds) => Ok(creds.token),
            Err(_) => crate::integration::github::try_gh_cli_token()
                .await
                .ok_or_else(|| "No GitHub credentials found".to_string()),
        }
    } else {
        crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)
            .map(|creds| creds.token)
    };

    let header = match provider {
        "github" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("x-access-token:{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        "gitlab" => format!("Authorization: Bearer {}", token_result?),
        "bitbucket" => {
            let creds = crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)?;
            match creds.instance_url {
                Some(_) => format!("Authorization: Bearer {}", creds.token),
                None => {
                    let email = creds.email.ok_or("Bitbucket Cloud credentials missing email")?;
                    let basic = base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{}", email, creds.token).as_bytes());
                    format!("Authorization: Basic {}", basic)
                }
            }
        }
        "forgejo" | "gitea" => format!("Authorization: token {}", token_result?),
        "azuredevops" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!(":{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        _ => return Ok(None),
    };

    Ok(Some(header))
}

/// Clone a git repository and register it as a project
#[tauri::command]
#[specta::specta]
pub async fn clone_project(
    app_state: State<'_, Arc<AppState>>,
    url: String,
    target_path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    provider: Option<String>,
) -> Result<crate::models::Project, String> {
    let connection_key = ConnectionKey::from_ids(connection_id, wsl_connection_id);
    let auth_header = match provider.as_deref() {
        Some(provider_key) if url.starts_with("http://") || url.starts_with("https://") => {
            build_provider_auth_header(provider_key, &app_state).await?
        }
        _ => None,
    };

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state
                .ssh.get_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let git_cmd = match &auth_header {
                Some(header) => format!(
                    "git -c {} clone {} {}",
                    shell_quote(&format!("http.extraHeader={}", header)),
                    shell_quote(&url),
                    shell_quote(&target_path),
                ),
                None => format!("git clone {} {}", shell_quote(&url), shell_quote(&target_path)),
            };
            let output = session
                .execute_command(&git_cmd)
                .await
                .map_err(|e| format!("SSH git clone failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("git clone failed: {}", output));
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let mut wsl_args = vec!["-d".to_string(), distro, "--".to_string(), "git".to_string()];
            // WSL has its own certificate store separate from Windows; disable SSL verification
            // so clones from internal servers with self-signed certs work out of the box.
            wsl_args.push("-c".to_string());
            wsl_args.push("http.sslVerify=false".to_string());
            if let Some(ref header) = auth_header {
                wsl_args.push("-c".to_string());
                wsl_args.push(format!("http.extraHeader={}", header));
            }
            wsl_args.extend(["clone".to_string(), url.clone(), target_path.clone()]);
            let output = tokio::process::Command::new("wsl.exe")
                .args(&wsl_args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if !output.status.success() {
                return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
        ConnectionKey::Local => {
            let mut args: Vec<String> = Vec::new();
            if let Some(header) = auth_header {
                args.push("-c".to_string());
                args.push(format!("http.extraHeader={}", header));
            }
            args.extend(["clone".to_string(), url.clone(), target_path.clone()]);
            let output = tokio::process::Command::new("git")
                .args(&args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    let name = std::path::Path::new(&target_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    register_project_in_db(app_state.inner(), &target_path, &name, connection_key)
}

/// Create a new project directory, git init it, and register as a project
#[tauri::command]
#[specta::specta]
pub async fn create_new_project(
    app_state: State<'_, Arc<AppState>>,
    parent_dir: String,
    folder_name: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<crate::models::Project, String> {
    let connection_key = ConnectionKey::from_ids(connection_id, wsl_connection_id);
    // Build full path string (works for both local and remote — remote paths are POSIX)
    let full_path_str = format!("{}/{}", parent_dir.trim_end_matches('/'), folder_name);

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state
                .ssh.get_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let exists = session
                .execute_command(&format!("test -d {} && echo yes || echo no", shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH check failed: {}", e))?;
            if exists.trim() == "yes" {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            let output = session
                .execute_command(&format!("mkdir -p {} && git init -b main {}", shell_quote(&full_path_str), shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH create failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("Remote create failed: {}", output));
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let exists_out = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "test", "-d", &full_path_str])
                .no_console_window()
                .status()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if exists_out.success() {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            let script = format!("mkdir -p {} && git init -b main {}", shell_quote(&full_path_str), shell_quote(&full_path_str));
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "sh", "-c", &script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("error:") || stderr.contains("fatal:") || !output.status.success() {
                return Err(format!("WSL create failed: {}", stderr));
            }
        }
        ConnectionKey::Local => {
            let full_path = std::path::Path::new(&parent_dir).join(&folder_name);
            if full_path.exists() {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            std::fs::create_dir_all(&full_path)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
            let output = tokio::process::Command::new("git")
                .args(["init", "-b", "main", &full_path_str])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    register_project_in_db(app_state.inner(), &full_path_str, &folder_name, connection_key)
}
