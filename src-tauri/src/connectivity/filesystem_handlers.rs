use std::fs;
use std::io;
use std::path::Path;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
}

/// List files and directories in a local path. Dirs come first, both groups sorted alphabetically.
/// Hidden entries (starting with `.`) are excluded.
#[tauri::command]
#[specta::specta]
pub fn list_local_contents(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let entries = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        match entry.metadata() {
            Ok(m) if m.is_dir() => dirs.push(name),
            Ok(_) => files.push(name),
            Err(_) => continue,
        }
    }
    dirs.sort();
    files.sort();
    let mut result: Vec<FileEntry> = dirs.into_iter().map(|n| FileEntry { name: n, is_dir: true }).collect();
    result.extend(files.into_iter().map(|n| FileEntry { name: n, is_dir: false }));
    Ok(result)
}

/// Recursively list all non-hidden files under root, returning paths relative to root.
/// Skips hidden entries, node_modules, target, and dist. Caps at 2000 files / depth 8.
#[tauri::command]
#[specta::specta]
pub fn list_workspace_files(root: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }
    let mut output = Vec::new();
    walk_files(root_path, root_path, 0, &mut output).map_err(|e| e.to_string())?;
    output.sort();
    Ok(output)
}

fn walk_files(root: &Path, dir: &Path, depth: u8, output: &mut Vec<String>) -> io::Result<()> {
    if depth > 8 || output.len() >= 2000 {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if matches!(name.as_str(), "node_modules" | "target" | "dist") {
                continue;
            }
            walk_files(root, &entry.path(), depth + 1, output)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if !relative.is_empty() {
                output.push(relative);
            }
        }
    }
    Ok(())
}

/// Read a local file's text content. Rejects binary files and files over 512 KB.
#[tauri::command]
#[specta::specta]
pub fn read_local_file(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut sample = [0u8; 512];
    let n = file.read(&mut sample).map_err(|e| e.to_string())?;
    if sample[..n].contains(&0u8) {
        return Err("Binary file".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 524_288 {
        return Err("File too large".to_string());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Read a local file's raw content as a base64-encoded string. Rejects files over 10 MB.
#[tauri::command]
#[specta::specta]
pub fn read_local_file_binary(path: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 10_485_760 {
        return Err("File too large".to_string());
    }
    Ok(STANDARD.encode(&bytes))
}

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

#[tauri::command]
#[specta::specta]
pub fn open_path_native(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

