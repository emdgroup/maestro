use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use crate::models::{ProjectConfig, ProjectState};

pub const CANVAS_CATALOG: &str = include_str!("../../assets/canvas-catalog.json");
pub const CANVAS_BASE_SKILL: &str = include_str!("../../assets/canvas-base-skill.md");

const DEFAULT_COMMIT_TEMPLATE: &str = "\
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.";

/// Replace a file without exposing partially-written contents to concurrent readers.
pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();

    for attempt in 0..100 {
        let temp_path = path.with_file_name(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            attempt
        ));
        let mut temp = match OpenOptions::new().write(true).create_new(true).open(&temp_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let result = (|| {
            temp.write_all(contents)?;
            temp.sync_all()?;
            drop(temp);
            replace_file(&temp_path, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        return result;
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate an atomic-write temporary file",
    ))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();

    // SAFETY: both pointers reference NUL-terminated UTF-16 buffers for the duration of the call.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Write the default commit template to .maestro/commit-template.txt if it doesn't exist.
/// Never overwrites an existing file so user edits are preserved.
pub fn ensure_commit_template_exists(project_path: &str) -> Result<(), String> {
    let template_path = Path::new(project_path).join(".maestro").join("commit-template.txt");
    if !template_path.exists() {
        std::fs::write(&template_path, DEFAULT_COMMIT_TEMPLATE)
            .map_err(|e| format!("Failed to write commit template: {}", e))?;
    }
    Ok(())
}

/// Initialize the .maestro directory structure for a project
///
/// Creates the .maestro folder if it doesn't exist.
/// Returns Ok(()) on success, or a descriptive error message on failure.
pub fn create_project_maestro_folder(project_path: &str) -> Result<(), String> {
    let maestro_path = Path::new(project_path).join(".maestro");

    std::fs::create_dir_all(&maestro_path).map_err(|e| {
        format!(
            "Failed to create .maestro folder for project '{}': {}",
            project_path, e
        )
    })
}

/// Save project configuration to .maestro/settings.json
///
/// Wrapper around ProjectConfig::save_to_project for clarity in the file I/O layer.
pub fn export_config_to_settings(config: &ProjectConfig, project_path: &str) -> Result<(), String> {
    config.save_to_project(project_path)
}

/// Save project state to .maestro/state.json
///
/// Wrapper around ProjectState::save_to_project for clarity in the file I/O layer.
pub fn export_state_to_file(state: &ProjectState, project_path: &str) -> Result<(), String> {
    state.save_to_project(project_path)
}

/// Load project configuration from .maestro/settings.json
///
/// If the file doesn't exist (new project), returns default configuration.
/// If the file exists but contains invalid JSON, returns error.
pub fn load_project_config(project_path: &str) -> Result<ProjectConfig, String> {
    match ProjectConfig::load_from_project(project_path) {
        Ok(config) => Ok(config),
        Err(e) => {
            // Check if the error is due to file not found
            if e.contains("No such file") || e.contains("not found") {
                // New project - return default configuration
                Ok(ProjectConfig::default())
            } else {
                // Actual JSON parse error or other issue
                Err(e)
            }
        }
    }
}

/// Load project state from .maestro/state.json
///
/// If the file doesn't exist (new project), returns empty state.
/// If the file exists but contains invalid JSON, returns error.
pub fn load_project_state(project_path: &str) -> Result<ProjectState, String> {
    match ProjectState::load_from_project(project_path) {
        Ok(state) => Ok(state),
        Err(e) => {
            // Check if the error is due to file not found
            if e.contains("No such file") || e.contains("not found") {
                // New project - return empty state
                Ok(ProjectState::empty())
            } else {
                // Actual JSON parse error or other issue
                Err(e)
            }
        }
    }
}

/// Write the bundled canvas catalog to .maestro/canvas-catalog.json, overwriting any existing file.
pub fn write_canvas_catalog(project_path: &str) -> Result<(), String> {
    let catalog_path = Path::new(project_path).join(".maestro").join("canvas-catalog.json");
    std::fs::write(&catalog_path, CANVAS_CATALOG)
        .map_err(|e| format!("Failed to write canvas catalog: {}", e))
}

/// Write the bundled canvas base skill to .maestro/canvas-base-skill.md, overwriting any existing file.
pub fn write_canvas_base_skill(project_path: &str) -> Result<(), String> {
    let skill_path = Path::new(project_path).join(".maestro").join("canvas-base-skill.md");
    std::fs::write(&skill_path, CANVAS_BASE_SKILL)
        .map_err(|e| format!("Failed to write canvas base skill: {}", e))
}

/// Ensure the .maestro folder exists, creating it if necessary
///
/// Safety check before any file operations.
/// Returns Ok(()) if the folder exists or was successfully created.
pub fn ensure_maestro_folder_exists(project_path: &str) -> Result<(), String> {
    let maestro_path = Path::new(project_path).join(".maestro");

    if maestro_path.exists() {
        Ok(())
    } else {
        create_project_maestro_folder(project_path)
    }
}

#[cfg(test)]
mod tests {
    use super::atomic_write;

    #[test]
    fn atomic_write_replaces_existing_contents_without_leaving_a_temp_file() {
        let dir = tempfile::tempdir().expect("temp directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").expect("initial write");

        atomic_write(&path, b"new contents").expect("atomic replacement");

        assert_eq!(std::fs::read(&path).expect("read replacement"), b"new contents");
        assert_eq!(std::fs::read_dir(dir.path()).expect("list directory").count(), 1);
    }

    #[test]
    fn atomic_write_cleans_up_when_replacement_fails() {
        let dir = tempfile::tempdir().expect("temp directory");
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).expect("destination directory");

        assert!(atomic_write(&path, b"new contents").is_err());

        assert!(path.is_dir(), "the original destination must remain intact");
        assert_eq!(std::fs::read_dir(dir.path()).expect("list directory").count(), 1);
    }
}
