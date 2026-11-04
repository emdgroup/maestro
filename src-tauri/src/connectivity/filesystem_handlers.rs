use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::io;
use std::path::Path;

use crate::connectivity::docker_handlers::run_blocking;
use crate::connectivity::files::{BINARY_LIMIT, TEXT_LIMIT};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
}

/// List files and directories in a local path. Dirs come first, both groups sorted alphabetically.
///
/// The local half of [`crate::connectivity::files::list_contents`]; a Windows host has no `ls` to
/// answer it the way every other connection type does.
pub(crate) async fn local_contents(
    path: String,
    include_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    run_blocking(move || {
        let dir_path = Path::new(&path);
        if !dir_path.is_dir() {
            return Err(format!("Not a directory: {}", path));
        }
        let entries =
            fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;
        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if !include_hidden && name.starts_with('.') {
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
        let mut result: Vec<FileEntry> = dirs
            .into_iter()
            .map(|n| FileEntry {
                name: n,
                is_dir: true,
            })
            .collect();
        result.extend(files.into_iter().map(|n| FileEntry {
            name: n,
            is_dir: false,
        }));
        Ok(result)
    })
    .await
}

/// Recursively list all files under root, returning paths relative to root.
/// Skips node_modules, target, and dist. Caps at 2000 files / depth 8.
pub(crate) async fn local_workspace_files(
    root: String,
    include_hidden: bool,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let root_path = Path::new(&root);
        if !root_path.is_dir() {
            return Err(format!("Not a directory: {}", root));
        }
        let mut output = Vec::new();
        walk_files(root_path, root_path, 0, include_hidden, &mut output)
            .map_err(|e| e.to_string())?;
        output.sort();
        Ok(output)
    })
    .await
}

fn walk_files(
    root: &Path,
    dir: &Path,
    depth: u8,
    include_hidden: bool,
    output: &mut Vec<String>,
) -> io::Result<()> {
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
        if name.starts_with('.') && !include_hidden {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            // `.git` stays out even with hidden entries asked for: its object store alone would
            // exhaust the 2000-file cap and leave no room for the files the picker exists to find.
            if matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git") {
                continue;
            }
            walk_files(root, &entry.path(), depth + 1, include_hidden, output)?;
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

/// Read a local file's text content. Rejects binary files and files over [`TEXT_LIMIT`].
pub async fn read_local_file(path: String) -> Result<String, String> {
    run_blocking(move || {
        use std::io::Read;
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut sample = [0u8; 512];
        let n = file.read(&mut sample).map_err(|e| e.to_string())?;
        if sample[..n].contains(&0u8) {
            return Err("Binary file".to_string());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > TEXT_LIMIT {
            return Err(format!(
                "File too large ({} KB, max {} KB)",
                bytes.len() / 1024,
                TEXT_LIMIT / 1024
            ));
        }
        String::from_utf8(bytes).map_err(|e| e.to_string())
    })
    .await
}

/// Read a local file's raw content as a base64-encoded string. Rejects files over [`BINARY_LIMIT`].
#[tauri::command]
#[specta::specta]
pub async fn read_local_file_binary(path: String) -> Result<String, String> {
    run_blocking(move || {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > BINARY_LIMIT {
            return Err("File too large".to_string());
        }
        Ok(STANDARD.encode(&bytes))
    })
    .await
}

/// List subdirectories in a local filesystem path
pub(crate) async fn local_directories(path: String) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let dir_path = Path::new(&path);

        // Check if path exists and is a directory
        if !dir_path.exists() {
            return Err(format!("Path does not exist: {}", path));
        }

        if !dir_path.is_dir() {
            return Err(format!("Path is not a directory: {}", path));
        }

        // Read directory entries
        let entries =
            fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

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
    })
    .await
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
pub async fn list_drives() -> Result<Vec<String>, String> {
    // Probing A:-Z: can block for seconds on unreachable network/removable drives
    run_blocking(|| {
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
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn open_path_native(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}
