use serde::{Deserialize, Serialize};
use specta::Type;

/// A WSL distro as reported by `wsl.exe --list --verbose`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WslDistro {
    pub name: String,
    pub state: WslDistroState,
    pub version: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum WslDistroState {
    Running,
    Stopped,
}

/// A WSL connection record stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WslConnection {
    pub id: i32,
    pub distro_name: String,
    pub display_name: Option<String>,
    pub last_used_at: String,
    pub created_at: String,
}

/// Check whether `wsl.exe` is available on this system.
/// Returns false on non-Windows platforms or when wsl.exe is not found.
pub fn is_wsl_available() -> bool {
    #[cfg(windows)]
    {
        use crate::command_ext::NoConsoleWindow;
        std::process::Command::new("wsl.exe")
            .arg("--version")
            .no_console_window()
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

/// List installed WSL distros using `wsl.exe --list --verbose`.
///
/// Returns an empty vec when WSL is unavailable or no distros are installed.
/// Verbose mode outputs a header followed by one distro per line with name, state, and version.
pub async fn list_distros() -> Result<Vec<WslDistro>, String> {
    #[cfg(windows)]
    {
        use crate::command_ext::NoConsoleWindow;
        let output = tokio::process::Command::new("wsl.exe")
            .args(["--list", "--verbose"])
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

        let text = decode_wsl_output(&output.stdout)?;

        Ok(parse_distro_list(&text))
    }
    #[cfg(not(windows))]
    Ok(vec![])
}

/// Run a command inside a distro through its exec channel, so it costs a message rather than a
/// `wsl.exe` start. Falls back to a cold spawn when no channel is available.
#[cfg(windows)]
pub(crate) async fn run(
    distro: &str,
    program: &str,
    args: &[&str],
) -> Result<crate::connectivity::exec_channel::CommandOutput, String> {
    crate::connectivity::exec_channel::run(
        &crate::connectivity::exec_channel::ExecTarget::Wsl { distro },
        None,
        program,
        args,
    )
    .await
}

/// List directory entries at `path` inside a WSL distro.
///
/// Runs `ls -1aF <path>` and returns the raw names. Trailing `/` on directories and `*` on
/// executables are preserved so the frontend can distinguish directories from files without a
/// separate stat.
pub async fn list_directories(distro: &str, path: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let output = run(distro, "ls", &["-1aF", path]).await?;
        if !output.success() {
            return Err(format!("ls failed: {}", output.stderr_string()));
        }

        let text = decode_wsl_output(&output.stdout)?;
        Ok(text
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && l != "." && l != "./" && l != ".." && l != "../")
            .collect())
    }
    #[cfg(not(windows))]
    {
        let _ = (distro, path);
        Err("WSL is only available on Windows".to_string())
    }
}

/// Get the home directory for a WSL distro's default user.
pub async fn get_home_dir(distro: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let output = run(distro, "sh", &["-c", "echo $HOME"]).await?;
        if !output.success() {
            return Err("Failed to get home directory from WSL".to_string());
        }

        let text = decode_wsl_output(&output.stdout)?;
        Ok(text.trim().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = distro;
        Err("WSL is only available on Windows".to_string())
    }
}

/// `\\wsl.localhost\<distro>\...`, the share Windows exposes for a distro's filesystem root.
///
/// Only the fallback for when [`to_windows_path`] cannot reach the distro to ask properly. It is
/// wrong for anything under `/mnt`, which already names a file on the host's own disk, and it
/// resolves at all only while the distro is running. `\\wsl$\` is the older name for the same
/// share — still accepted, but not worth spreading further.
#[cfg_attr(not(windows), allow(dead_code))]
fn unc_fallback(distro: &str, path: &str) -> String {
    format!(r"\\wsl.localhost\{}\{}", distro, path.trim_start_matches('/').replace('/', "\\"))
}

/// The Windows path naming the same file as `path` inside `distro`.
///
/// `wslpath` is asked rather than prefixing [`unc_fallback`] because the two disagree exactly where
/// it matters: `/mnt/c/Users/x` is `C:\Users\x`, a file on the host's own disk, and the prefix form
/// would route it out through the distro's 9P server and back.
pub async fn to_windows_path(distro: &str, path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        match run(distro, "wslpath", &["-w", path]).await {
            Ok(output) if output.success() => {
                let text = decode_wsl_output(&output.stdout)?;
                if !text.trim().is_empty() {
                    return Ok(text.trim().to_string());
                }
                log::warn!("wslpath -w gave no output for '{path}' in {distro}");
            }
            Ok(output) => {
                log::warn!(
                    "wslpath -w failed for '{path}' in {distro}: {}",
                    output.stderr_string()
                );
            }
            Err(e) => log::warn!("Could not run wslpath in {distro}: {e}"),
        }
        Ok(unc_fallback(distro, path))
    }
    #[cfg(not(windows))]
    {
        let _ = (distro, path);
        Err("WSL is only available on Windows".to_string())
    }
}

/// The path inside `distro` naming the same file as the Windows path `path`, so a host file can be
/// handed to something running in the distro.
///
/// Unlike [`to_windows_path`] this has no string fallback: a drive letter has no meaning inside the
/// distro beyond whatever `wslpath` says it is mounted at.
pub async fn to_wsl_path(distro: &str, path: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let output = run(distro, "wslpath", &["-u", path]).await?;
        if !output.success() {
            return Err(format!(
                "Cannot map '{path}' into {distro}: {}",
                output.stderr_string()
            ));
        }
        let text = decode_wsl_output(&output.stdout)?;
        if text.trim().is_empty() {
            return Err(format!("wslpath produced no path for '{path}'"));
        }
        Ok(text.trim().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (distro, path);
        Err("WSL is only available on Windows".to_string())
    }
}

/// Decode wsl.exe output, handling both UTF-16LE (with/without BOM) and UTF-8.
#[cfg(windows)]
pub fn decode_wsl_output_pub(bytes: &[u8]) -> Result<String, String> {
    decode_wsl_output(bytes)
}

#[cfg(windows)]
fn decode_wsl_output(bytes: &[u8]) -> Result<String, String> {
    // UTF-16LE BOM: 0xFF 0xFE
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let utf16: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&utf16)
            .map_err(|e| format!("UTF-16 decode error: {e}"));
    }
    // Fall back to UTF-8 (strip BOM if present)
    let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        std::str::from_utf8(&bytes[3..])
    } else {
        std::str::from_utf8(bytes)
    };
    text.map(|s| s.to_string()).map_err(|e| format!("UTF-8 decode error: {e}"))
}

/// Parse the output of `wsl.exe --list --verbose`.
///
/// Verbose output format:
///   NAME      STATE           VERSION
/// * Ubuntu    Running         2
///   Debian    Stopped         1
///
/// The `*` marks the default distro. Lines with fewer than 3 whitespace-separated
/// tokens (e.g. the header) are skipped. State defaults to `Stopped` for unknown values.
#[cfg(windows)]
fn parse_distro_list(text: &str) -> Vec<WslDistro> {
    text.lines()
        .map(|line| line.replace('\0', ""))
        .filter_map(|line| {
            // Strip the default-distro marker and leading/trailing whitespace
            let stripped = line.trim_start_matches('*').trim().to_string();
            let parts: Vec<&str> = stripped.split_whitespace().collect();
            // Need at least name + state + version; skip header line (name = "NAME")
            if parts.len() < 3 || parts[0].eq_ignore_ascii_case("NAME") {
                return None;
            }
            let name = parts[0].to_string();
            let state = match parts[1] {
                "Running" => WslDistroState::Running,
                _ => WslDistroState::Stopped,
            };
            let version = parts[2].parse::<u8>().unwrap_or(2);
            Some(WslDistro { name, state, version })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::unc_fallback;

    /// The fallback is what a caller gets when the distro cannot be asked, so it has to be a path
    /// Windows still accepts — and specifically not `\\wsl$\`, which this replaced.
    #[test]
    fn unc_fallback_uses_the_current_share_name_and_windows_separators() {
        assert_eq!(
            unc_fallback("Ubuntu", "/root/.claude/memory/MEMORY.md"),
            r"\\wsl.localhost\Ubuntu\root\.claude\memory\MEMORY.md"
        );
    }

    /// The leading `/` is the separator after the distro name, not a component of its own —
    /// keeping it would produce a doubled backslash and an unresolvable path.
    #[test]
    fn unc_fallback_does_not_leave_an_empty_first_component() {
        assert_eq!(unc_fallback("Debian", "/tmp"), r"\\wsl.localhost\Debian\tmp");
        assert!(!unc_fallback("Debian", "//tmp").contains(r"\\tmp"));
    }
}
