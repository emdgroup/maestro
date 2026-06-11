use std::path::Path;
use crate::models::{ProjectConfig, ProjectState};

pub const CANVAS_CATALOG: &str = include_str!("../../assets/canvas-catalog.json");

const DEFAULT_COMMIT_TEMPLATE: &str = "\
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.";

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
