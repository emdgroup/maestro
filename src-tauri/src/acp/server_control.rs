//! The background server as something the user can see, start with the machine, and stop.
//!
//! Starting with the machine is written here for the machine the app runs on, and by the server
//! itself on an SSH host. Here the entry does not start `maestro-server` directly: it starts this
//! app with `--start-server`, which starts the server and exits before any window exists. On
//! Windows that is the difference between a console window at every login and none, because the
//! app is a windowed program and the server is not.

use crate::acp::ConnectionKey;
use crate::core::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(not(windows))]
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

pub const START_SERVER_FLAG: &str = "--start-server";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Autostart {
    /// Nothing starts a server on this kind of connection on its own: WSL and containers.
    Unsupported,
    Off,
    /// At login, on the machine the app runs on.
    Login,
    Systemd,
    Cron,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackgroundServer {
    pub version: String,
    pub started_at: String,
    pub live_sessions: u32,
    pub running_runs: u32,
    pub autostart: Autostart,
}

/// The connection's server, for its Settings page.
#[tauri::command]
#[specta::specta]
pub async fn get_background_server(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<BackgroundServer, String> {
    let status =
        crate::acp::connection_server::query_server_status_via_server(connection, None, &app_state)
            .await?;
    let autostart = match connection {
        ConnectionKey::Local => local_autostart(&app_state)?,
        _ => remote_autostart(&status),
    };
    Ok(describe(status, autostart))
}

/// Start the connection's server with its machine, or stop doing so. Never stops the server.
#[tauri::command]
#[specta::specta]
pub async fn set_background_server_autostart(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    enabled: bool,
) -> Result<BackgroundServer, String> {
    match connection {
        ConnectionKey::Local => {
            set_local_autostart(&app_state, enabled).await?;
            get_background_server(app_state, connection).await
        }
        ConnectionKey::Ssh { .. } => {
            let status = crate::acp::connection_server::query_server_status_via_server(
                connection,
                Some(enabled),
                &app_state,
            )
            .await?;
            let autostart = remote_autostart(&status);
            Ok(describe(status, autostart))
        }
        ConnectionKey::Wsl { .. } | ConnectionKey::Docker { .. } => {
            Err("This connection's server cannot start on its own".to_string())
        }
    }
}

/// Stop the connection's server. Every session and run on it ends; the next connection starts a
/// fresh one.
#[tauri::command]
#[specta::specta]
pub async fn stop_background_server(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<(), String> {
    crate::acp::connection_server::stop_connection_server(connection, &app_state).await
}

fn describe(status: maestro_protocol::ServerStatus, autostart: Autostart) -> BackgroundServer {
    BackgroundServer {
        version: status.version,
        started_at: status.started_at,
        live_sessions: status.live_sessions,
        running_runs: status.running_runs,
        autostart,
    }
}

fn remote_autostart(status: &maestro_protocol::ServerStatus) -> Autostart {
    match status.autostart {
        _ if !status.autostart_supported => Autostart::Unsupported,
        Some(maestro_protocol::AutostartMethod::Systemd) => Autostart::Systemd,
        Some(maestro_protocol::AutostartMethod::Cron) => Autostart::Cron,
        None => Autostart::Off,
    }
}

/// What the login entry runs from `main`, before anything else: start the server and leave.
///
/// Returns the process exit code. Nothing is logged, because the logger is set up from a database
/// this path never opens; a server that fails to start here is started by the next connection.
pub fn start_server_at_login(args: &[std::ffi::OsString]) -> i32 {
    use crate::command_ext::NoConsoleWindow;
    let [server, daemon_dir] = args else {
        return 2;
    };
    let started = std::process::Command::new(server)
        .arg("daemon")
        .env(maestro_protocol::DAEMON_DIR_ENV, daemon_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_console_window()
        .spawn();
    match started {
        Ok(_child) => 0,
        Err(_) => 1,
    }
}

/// Named after the app identifier, so a development build has an entry of its own.
fn entry_name(app_state: &AppState) -> String {
    format!("{}.server", app_state.app_handle.config().identifier)
}

async fn login_arguments(app_state: &AppState) -> Result<Vec<String>, String> {
    let app = std::env::current_exe().map_err(|e| format!("cannot locate this app: {e}"))?;
    let server = crate::acp::deploy::ensure_local_server(&app_state.app_handle).await?;
    Ok(vec![
        app.to_string_lossy().into_owned(),
        START_SERVER_FLAG.to_string(),
        server.to_string_lossy().into_owned(),
        crate::acp::transport_setup::local_daemon_dir(app_state)
            .to_string_lossy()
            .into_owned(),
    ])
}

#[cfg(not(windows))]
fn home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "cannot resolve the home directory".to_string())
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn reg(args: &[&str]) -> Result<std::process::Output, String> {
    use crate::command_ext::NoConsoleWindow;
    std::process::Command::new("reg")
        .args(args)
        .no_console_window()
        .output()
        .map_err(|e| format!("cannot run reg: {e}"))
}

#[cfg(windows)]
fn local_autostart(app_state: &AppState) -> Result<Autostart, String> {
    let found = reg(&["query", RUN_KEY, "/v", &entry_name(app_state)])?;
    Ok(if found.status.success() {
        Autostart::Login
    } else {
        Autostart::Off
    })
}

#[cfg(windows)]
async fn set_local_autostart(app_state: &AppState, enabled: bool) -> Result<(), String> {
    let name = entry_name(app_state);
    let output = if enabled {
        let line = windows_command_line(&login_arguments(app_state).await?);
        reg(&[
            "add", RUN_KEY, "/v", &name, "/t", "REG_SZ", "/d", &line, "/f",
        ])?
    } else if local_autostart(app_state)? == Autostart::Login {
        reg(&["delete", RUN_KEY, "/v", &name, "/f"])?
    } else {
        return Ok(());
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Every argument quoted. A Windows path cannot contain `"`, so there is nothing to escape.
#[cfg(any(windows, test))]
fn windows_command_line(args: &[String]) -> String {
    args.iter()
        .map(|arg| format!("\"{arg}\""))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(not(windows))]
fn entry_path(app_state: &AppState) -> Result<PathBuf, String> {
    let name = entry_name(app_state);
    #[cfg(target_os = "macos")]
    return Ok(home()?.join(format!("Library/LaunchAgents/{name}.plist")));
    #[cfg(not(target_os = "macos"))]
    {
        let config = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map_or_else(|| home().map(|home| home.join(".config")), Ok)?;
        Ok(config.join("autostart").join(format!("{name}.desktop")))
    }
}

#[cfg(not(windows))]
fn local_autostart(app_state: &AppState) -> Result<Autostart, String> {
    Ok(if entry_path(app_state)?.exists() {
        Autostart::Login
    } else {
        Autostart::Off
    })
}

#[cfg(not(windows))]
async fn set_local_autostart(app_state: &AppState, enabled: bool) -> Result<(), String> {
    let path = entry_path(app_state)?;
    if !enabled {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("cannot remove {}: {e}", path.display()))
            }
            _ => Ok(()),
        };
    }
    let args = login_arguments(app_state).await?;
    #[cfg(target_os = "macos")]
    let body = launch_agent(&entry_name(app_state), &args);
    #[cfg(not(target_os = "macos"))]
    let body = desktop_entry(&args);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// `AbandonProcessGroup`, because launchd otherwise kills what a finished job started, and the
/// job here is the launcher, which finishes at once.
#[cfg(any(target_os = "macos", test))]
fn launch_agent(label: &str, args: &[String]) -> String {
    let escape = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let arguments: String = args
        .iter()
        .map(|arg| format!("\n    <string>{}</string>", escape(arg)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>{arguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
"#,
        escape(label)
    )
}

#[cfg(any(all(unix, not(target_os = "macos")), test))]
fn desktop_entry(args: &[String]) -> String {
    // The desktop entry spec's quoting: inside double quotes, backslash-escape `"`, `` ` ``, `$`
    // and `\`, then escape each backslash once more as the value is itself a string; `%` is a
    // field code everywhere.
    let exec = args
        .iter()
        .map(|arg| {
            let quoted = arg
                .replace('\\', r"\\")
                .replace('"', r#"\""#)
                .replace('`', r"\`")
                .replace('$', r"\$");
            format!("\"{}\"", quoted.replace('\\', r"\\").replace('%', "%%"))
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "[Desktop Entry]\nType=Application\nName=Maestro background server\nExec={exec}\n\
         NoDisplay=true\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Vec<String> {
        vec![
            "/Applications/Maestro.app/Contents/MacOS/maestro".to_string(),
            START_SERVER_FLAG.to_string(),
            "/Users/me/Library/Application Support/com.maestro.app/bin/maestro-server".to_string(),
            "/Users/me/Library/Application Support/com.maestro.app/daemon".to_string(),
        ]
    }

    #[test]
    fn the_windows_entry_quotes_every_argument() {
        let line = windows_command_line(&[
            r"C:\Program Files\Maestro\maestro.exe".to_string(),
            START_SERVER_FLAG.to_string(),
        ]);
        assert_eq!(
            line,
            r#""C:\Program Files\Maestro\maestro.exe" "--start-server""#
        );
    }

    #[test]
    fn the_launch_agent_carries_each_argument_and_outlives_its_launcher() {
        let plist = launch_agent("com.maestro.app.server", &args());
        assert!(plist.contains("<string>com.maestro.app.server</string>"));
        assert!(plist.contains("<string>--start-server</string>"));
        assert!(plist.contains("Application Support/com.maestro.app/daemon</string>"));
        assert!(plist.contains("<key>AbandonProcessGroup</key>\n  <true/>"));
    }

    #[test]
    fn the_desktop_entry_quotes_paths_with_spaces_and_escapes_what_it_must() {
        let entry = desktop_entry(&["/home/me/100% $HOME/app".to_string()]);
        assert!(
            entry.contains(r#"Exec="/home/me/100%% \\$HOME/app""#),
            "{entry}"
        );
    }

    #[test]
    fn the_launcher_refuses_arguments_it_does_not_understand() {
        assert_eq!(start_server_at_login(&[]), 2);
    }
}
