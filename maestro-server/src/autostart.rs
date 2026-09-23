//! Starting this server with its machine, on a Linux host the app reaches over SSH.
//!
//! On the machine the app runs on, the app writes the login entry itself, since only it can start
//! the server without a console window on Windows. Here nothing is logged in to start anything, so
//! it is a systemd user unit with linger, and a crontab `@reboot` line where either is missing.
//! Both go through `bash -lc`, as the SSH transport does, so the agents this server spawns get the
//! `PATH` a login gives rather than cron's or systemd's bare one.

use maestro_protocol::AutostartMethod;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const UNIT: &str = "maestro-server.service";
/// Ends the crontab line this module owns, so it can be found and removed again.
const CRON_MARK: &str = "# maestro-server autostart";

pub(crate) fn supported() -> bool {
    cfg!(target_os = "linux")
}

/// How this server is currently set to start, if it is.
pub(crate) fn current() -> Option<AutostartMethod> {
    if !supported() {
        return None;
    }
    if unit_path().is_some_and(|path| path.exists())
        && systemctl(&["is-enabled", "--quiet", UNIT]).is_ok()
    {
        return Some(AutostartMethod::Systemd);
    }
    if crontab().is_some_and(|table| table.lines().any(|line| line.ends_with(CRON_MARK))) {
        return Some(AutostartMethod::Cron);
    }
    None
}

/// Turn starting with the machine on or off, and say how it ended up.
///
/// Blocking: every step is a short child process.
pub(crate) fn set(enabled: bool) -> Result<Option<AutostartMethod>, String> {
    if !supported() {
        return Err("Starting with the machine is only offered on Linux hosts".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate this binary: {e}"))?;
    remove_systemd();
    remove_cron()?;
    if !enabled {
        return Ok(None);
    }
    match install_systemd(&exe) {
        Ok(()) => Ok(Some(AutostartMethod::Systemd)),
        Err(systemd) => {
            remove_systemd();
            install_cron(&exe)
                .map(|()| Some(AutostartMethod::Cron))
                .map_err(|cron| format!("{systemd}. {cron}"))
        }
    }
}

fn install_systemd(exe: &Path) -> Result<(), String> {
    systemctl(&["show-environment"]).map_err(|e| format!("No systemd user manager: {e}"))?;
    let path = unit_path().ok_or("cannot resolve the home directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, unit_file(exe))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", UNIT])?;
    // Without linger the unit starts at the first login, which on a server may be never.
    if !lingering() {
        run("loginctl", &["enable-linger"], None).map_err(|e| {
            format!(
                "Linger refused ({e}); an admin can run `loginctl enable-linger {}`",
                user()
            )
        })?;
    }
    Ok(())
}

fn remove_systemd() {
    let Some(path) = unit_path().filter(|path| path.exists()) else {
        return;
    };
    // Best effort throughout: what matters is that the file is gone, which the next check reads.
    let steps = [
        systemctl(&["disable", UNIT]).map(drop),
        std::fs::remove_file(&path).map_err(|e| e.to_string()),
        systemctl(&["daemon-reload"]).map(drop),
    ];
    for failed in steps.into_iter().filter_map(Result::err) {
        crate::send_diag("warn", format!("[autostart] removing the unit: {failed}"));
    }
}

fn install_cron(exe: &Path) -> Result<(), String> {
    let table = crontab().unwrap_or_default();
    write_crontab(&format!("{}{}\n", strip_cron(&table), cron_line(exe)))
        .map_err(|e| format!("No crontab either: {e}"))
}

fn remove_cron() -> Result<(), String> {
    match crontab() {
        Some(table) if table.lines().any(|line| line.ends_with(CRON_MARK)) => {
            write_crontab(&strip_cron(&table))
        }
        _ => Ok(()),
    }
}

/// The command both methods run, as one shell word for `bash -lc`.
fn launch(exe: &Path) -> String {
    format!("exec {} daemon", shell_quoted(&exe.to_string_lossy()))
}

fn shell_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn unit_file(exe: &Path) -> String {
    // systemd reads `$` and `%` in ExecStart itself, and unquotes double quotes.
    let command = launch(exe)
        .replace('\\', r"\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!(
        "[Unit]\nDescription=Maestro background server\n\n\
         [Service]\nExecStart=/usr/bin/env bash -lc \"{command}\"\n\n\
         [Install]\nWantedBy=default.target\n"
    )
}

fn cron_line(exe: &Path) -> String {
    // cron turns an unescaped `%` into a newline.
    let command = shell_quoted(&launch(exe)).replace('%', r"\%");
    format!("@reboot bash -lc {command} >/dev/null 2>&1 {CRON_MARK}")
}

/// A crontab without this module's line, keeping everything else as it was.
fn strip_cron(table: &str) -> String {
    table
        .lines()
        .filter(|line| !line.ends_with(CRON_MARK))
        .map(|line| format!("{line}\n"))
        .collect()
}

fn unit_path() -> Option<PathBuf> {
    let config = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|home| Path::new(&home).join(".config"))
        })?;
    Some(config.join("systemd").join("user").join(UNIT))
}

fn user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .or_else(|| run("id", &["-un"], None).ok())
        .unwrap_or_default()
}

fn lingering() -> bool {
    Path::new("/var/lib/systemd/linger").join(user()).exists()
}

/// `systemctl --user`, which needs the user's runtime directory to find its manager. A server
/// started from an SSH login usually inherits it; one started by cron does not.
fn systemctl(args: &[&str]) -> Result<String, String> {
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok().or_else(|| {
        run("id", &["-u"], None)
            .ok()
            .map(|uid| format!("/run/user/{uid}"))
    });
    let mut all = vec!["--user"];
    all.extend_from_slice(args);
    run("systemctl", &all, runtime.as_deref())
}

fn crontab() -> Option<String> {
    run("crontab", &["-l"], None).ok()
}

fn write_crontab(table: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = Command::new("crontab")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run crontab: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(table.as_bytes())
            .map_err(|e| format!("cannot write the crontab: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("crontab failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Run a command to completion, returning its trimmed stdout, or its stderr as the error.
fn run(program: &str, args: &[&str], runtime_dir: Option<&str>) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    if let Some(dir) = runtime_dir {
        command.env("XDG_RUNTIME_DIR", dir);
    }
    let output = command
        .output()
        .map_err(|e| format!("cannot run {program}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program} exited with {}", output.status)
        } else {
            stderr
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_crontab_line_is_found_and_removed_without_touching_the_rest() {
        let exe = Path::new("/home/me/.maestro/bin/maestro-server");
        let table = format!("0 * * * * backup\n{}\nMAILTO=me\n", cron_line(exe));
        assert_eq!(strip_cron(&table), "0 * * * * backup\nMAILTO=me\n");
        assert_eq!(strip_cron(""), "");
    }

    #[test]
    fn the_crontab_line_quotes_the_path_and_escapes_percent() {
        let line = cron_line(Path::new("/home/o'neil/100%/maestro-server"));
        assert!(line.starts_with("@reboot bash -lc "));
        assert!(line.ends_with(CRON_MARK));
        assert!(line.contains(r"100\%"), "{line}");
        assert!(!line.contains("100%/"), "{line}");
    }

    #[test]
    fn the_unit_escapes_what_systemd_would_expand() {
        let unit = unit_file(Path::new("/opt/$x/50%/maestro-server"));
        assert!(unit.contains(
            "ExecStart=/usr/bin/env bash -lc \"exec '/opt/$$x/50%%/maestro-server' daemon\""
        ));
        assert!(unit.contains("WantedBy=default.target"));
    }
}
