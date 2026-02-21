use std::fs;
use std::path::Path;

/// List subdirectories in a local filesystem path
#[tauri::command]
pub fn list_local_directories(path: String) -> Result<Vec<String>, String> {
    println!("list_local_directories(path={}) called via IPC", path);

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
    for entry in entries {
        if let Ok(entry) = entry {
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
    }

    // Sort alphabetically
    directories.sort();

    println!("Found {} subdirectories in {}", directories.len(), path);
    Ok(directories)
}

/// Get the default file picker path based on the current platform
#[tauri::command]
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

        println!("Found {} drives: {:?}", drives.len(), drives);
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
pub fn get_system_accent_color() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        // Try GNOME/GTK accent color via gsettings
        if let Ok(output) = Command::new("gsettings")
            .args(&["get", "org.gnome.desktop.interface", "accent-color"])
            .output()
        {
            if output.status.success() {
                let color_name = String::from_utf8_lossy(&output.stdout).trim().trim_matches('\'').to_string();
                println!("[Accent] GNOME accent-color: {}", color_name);

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
        println!("[Accent] Using fallback blue accent color");
        Ok(vec![53, 132, 228]) // GNOME blue
    }

    #[cfg(target_os = "macos")]
    {
        // TODO: Implement macOS accent color detection via NSColor
        println!("[Accent] macOS accent color not yet implemented, using fallback");
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

                        println!("[Accent] Windows accent color detected via UISettings: RGB({}, {}, {})", r, g, b);
                        Ok(vec![r, g, b])
                    }
                    Err(e) => {
                        println!("[Accent] Failed to get accent color from UISettings: {:?}, using fallback", e);
                        Ok(vec![0, 120, 212]) // Windows default blue
                    }
                }
            }
            Err(e) => {
                println!("[Accent] Failed to create UISettings instance: {:?}, using fallback", e);
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
