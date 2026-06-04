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
pub fn list_distros() -> Result<Vec<WslDistro>, String> {
    #[cfg(windows)]
    {
        use crate::command_ext::NoConsoleWindow;
        let output = std::process::Command::new("wsl.exe")
            .args(["--list", "--verbose"])
            .no_console_window()
            .output()
            .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

        let text = decode_wsl_output(&output.stdout)?;

        Ok(parse_distro_list(&text))
    }
    #[cfg(not(windows))]
    Ok(vec![])
}

/// List directory entries at `path` inside a WSL distro.
///
/// Runs `wsl.exe -d <distro> -- ls -1aF <path>` and returns the raw names.
/// Trailing `/` on directories and `*` on executables are preserved so the
/// frontend can distinguish directories from files without a separate stat.
pub fn list_directories(distro: &str, path: &str) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        use crate::command_ext::NoConsoleWindow;
        let output = std::process::Command::new("wsl.exe")
            .args(["-d", distro, "--", "ls", "-1aF", path])
            .no_console_window()
            .output()
            .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ls failed: {stderr}"));
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
pub fn get_home_dir(distro: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use crate::command_ext::NoConsoleWindow;
        let output = std::process::Command::new("wsl.exe")
            .args(["-d", distro, "--", "sh", "-c", "echo $HOME"])
            .no_console_window()
            .output()
            .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

        if !output.status.success() {
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
