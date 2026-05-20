use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
use crate::wsl::{WslConnection, WslDistro};

/// List subdirectories in a local filesystem path
#[tauri::command]
#[specta::specta]
pub fn list_local_directories(path: String) -> Result<Vec<String>, String> {
    let dir_path = Path::new(&path);

    // Check if path exists and is a directory
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Read directory entries
    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    // Filter for directories only
    let mut directories: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    // Skip . and .. (though these shouldn't appear from read_dir)
                    if name != "." && name != ".." {
                        directories.push(name.to_string());
                    }
                }
            }
        }
    }

    // Sort alphabetically
    directories.sort();

    Ok(directories)
}

/// Get the default file picker path based on the current platform
#[tauri::command]
#[specta::specta]
pub fn get_default_file_picker_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, default to C:/Users
        Ok("C:/Users".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, default to /Users
        Ok("/Users".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, default to /home
        Ok("/home".to_string())
    }
}

/// List available drives (Windows only)
#[tauri::command]
#[specta::specta]
pub fn list_drives() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut drives = Vec::new();

        // Check common drive letters A-Z
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:/", letter as char);
            // Try to read the drive root to see if it exists
            if fs::metadata(&drive).is_ok() {
                drives.push(drive);
            }
        }

        Ok(drives)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows systems, return empty list
        Ok(Vec::new())
    }
}

/// Get system accent color as RGB values
/// Returns [r, g, b] where each value is 0-255
#[tauri::command]
#[specta::specta]
pub fn get_system_accent_color() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        // Try GNOME/GTK accent color via gsettings
        if let Ok(output) = Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "accent-color"])
            .output()
        {
            if output.status.success() {
                let color_name = String::from_utf8_lossy(&output.stdout).trim().trim_matches('\'').to_string();

                // GNOME accent colors mapping (GNOME 42+)
                let rgb = match color_name.as_str() {
                    "blue" => vec![53, 132, 228],
                    "teal" => vec![0, 163, 164],
                    "green" => vec![51, 209, 122],
                    "yellow" => vec![229, 165, 10],
                    "orange" => vec![255, 120, 0],
                    "red" => vec![230, 97, 0],
                    "pink" => vec![213, 16, 180],
                    "purple" => vec![145, 65, 172],
                    "slate" => vec![112, 128, 144],
                    _ => vec![53, 132, 228], // Default to blue
                };

                return Ok(rgb);
            }
        }

        // Fallback: Return a neutral blue
        Ok(vec![53, 132, 228]) // GNOME blue
    }

    #[cfg(target_os = "macos")]
    {
        // TODO: Implement macOS accent color detection via NSColor
        Ok(vec![0, 122, 255]) // macOS default blue
    }

    #[cfg(target_os = "windows")]
    {
        use windows::UI::ViewManagement::{UISettings, UIColorType};

        // Use Windows.UI.ViewManagement.UISettings to get system accent color
        // This is the official Microsoft-recommended API
        match UISettings::new() {
            Ok(ui_settings) => {
                match ui_settings.GetColorValue(UIColorType::Accent) {
                    Ok(color) => {
                        // Windows.UI.Color struct has R, G, B, A fields (all u8)
                        let r = color.R;
                        let g = color.G;
                        let b = color.B;

                        Ok(vec![r, g, b])
                    }
                    Err(_) => {
                        Ok(vec![0, 120, 212]) // Windows default blue
                    }
                }
            }
            Err(_) => {
                Ok(vec![0, 120, 212]) // Windows default blue
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        // Unknown platform
        Ok(vec![53, 132, 228])
    }
}

/// List installed WSL distros. Returns empty vec on non-Windows.
#[tauri::command]
#[specta::specta]
pub fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    crate::wsl::list_distros()
}

/// List entries in a WSL distro directory.
#[tauri::command]
#[specta::specta]
pub fn list_wsl_directories(distro: String, path: String) -> Result<Vec<String>, String> {
    crate::wsl::list_directories(&distro, &path)
}

/// Get the home directory for the default user in a WSL distro.
#[tauri::command]
#[specta::specta]
pub fn get_wsl_home(distro: String) -> Result<String, String> {
    crate::wsl::get_home_dir(&distro)
}

/// Upsert a WSL connection record and return the saved row.
#[tauri::command]
#[specta::specta]
pub fn save_wsl_connection(
    app_state: State<Arc<AppState>>,
    distro_name: String,
    display_name: Option<String>,
) -> Result<WslConnection, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    conn.execute(
        "INSERT INTO wsl_connections (distro_name, display_name, last_used_at, created_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(distro_name) DO UPDATE SET display_name = excluded.display_name, last_used_at = excluded.last_used_at",
        rusqlite::params![distro_name, display_name, now],
    ).map_err(|e| format!("Failed to save WSL connection: {e}"))?;

    let row = conn.query_row(
        "SELECT id, distro_name, display_name, last_used_at, created_at FROM wsl_connections WHERE distro_name = ?",
        [&distro_name],
        |row| Ok(WslConnection {
            id: row.get(0)?,
            distro_name: row.get(1)?,
            display_name: row.get(2)?,
            last_used_at: row.get(3)?,
            created_at: row.get(4)?,
        }),
    ).map_err(|e| format!("Failed to read WSL connection: {e}"))?;
    Ok(row)
}

/// List all saved WSL connections from the database.
#[tauri::command]
#[specta::specta]
pub fn get_wsl_connections(app_state: State<Arc<AppState>>) -> Result<Vec<WslConnection>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, distro_name, display_name, last_used_at, created_at FROM wsl_connections ORDER BY last_used_at DESC")
        .map_err(|e| format!("DB prepare failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| Ok(WslConnection {
            id: row.get(0)?,
            distro_name: row.get(1)?,
            display_name: row.get(2)?,
            last_used_at: row.get(3)?,
            created_at: row.get(4)?,
        }))
        .map_err(|e| format!("DB query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB row failed: {e}"))?;
    Ok(rows)
}
