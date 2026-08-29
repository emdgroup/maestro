use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::core::AppState;
use crate::core::project_storage::{read_maestro_json, write_maestro_json};
use crate::models::{GitConnection, ProjectConfig};

pub const SETTINGS_FILE: &str = "settings.json";

/// Serialises every read-modify-write of `.maestro/settings.json`.
///
/// One mutex for all projects rather than one per project: the critical section is a single
/// small read plus a single small write, and these writes are rare.
static SETTINGS_WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Read `.maestro/settings.json` for a project, from whichever machine the project lives on.
///
/// A missing or unparseable file yields the default config: a project that has never opened the
/// settings UI has no file at all, and that is not an error.
pub async fn load_project_config_for(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<ProjectConfig, String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(read_maestro_json(&conn, SETTINGS_FILE).await)
}

/// Read-modify-write `.maestro/settings.json` under [`SETTINGS_WRITE`], re-reading inside it.
///
/// The document is a single struct mutated by six handlers, two of which — issue-tracking and
/// code-hosting detection — hold their snapshot across a `git remote -v` and an HTTP round trip
/// before writing the whole thing back. Re-reading here is what stops a colour picked, or a
/// switch flipped, during that window from being restored to what the detector saw on entry.
/// Callers must therefore decide *inside* the closure, against the config it is handed, rather
/// than passing a decision made from an earlier read.
///
/// The closure reports whether it changed anything. `false` skips the write entirely, so a
/// detector that declines to apply neither rewrites the file nor creates one that was absent.
pub async fn mutate_project_config<F>(conn: &GitConnection, mutate: F) -> Result<bool, String>
where
    F: FnOnce(&mut ProjectConfig) -> bool,
{
    let _guard = SETTINGS_WRITE.lock().await;

    let mut config: ProjectConfig = read_maestro_json(conn, SETTINGS_FILE).await;
    if !mutate(&mut config) {
        return Ok(false);
    }
    config.updated_at = Utc::now().to_rfc3339();

    write_maestro_json(conn, SETTINGS_FILE, &config).await?;
    Ok(true)
}

/// Get project-level configuration from .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn get_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    let config = load_project_config_for(&app_state, project_id).await?;
    // Resolved before the fields below are moved out of `config`.
    let default_workspace_mode = config.default_workspace_mode();
    Ok(crate::models::ProjectConfigResponse {
        default_agent: config.default_agent,
        startup_tab: config.startup_tab,
        accent_color: config.accent_color,
        accent_color_auto_assign: config.accent_color_auto_assign,
        default_workspace_mode,
    })
}

/// Set only the project's accent colour in .maestro/settings.json.
///
/// Separate from `update_project_settings` so the settings form (which writes the whole
/// `ProjectConfigRequest`) can never clobber a colour picked in the header a moment earlier.
#[tauri::command]
#[specta::specta]
pub async fn set_project_accent_color(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    accent_color: Option<String>,
) -> Result<(), String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    mutate_project_config(&conn, |config| {
        config.accent_color = accent_color;
        // Records that the colour is now settled, whether that is a hue or a deliberate "follow
        // the global default" — the latter stores no hue, so without this the first-open
        // assignment would overwrite the choice on the next open.
        config.accent_color_auto_assign = Some(false);
        true
    })
    .await?;

    Ok(())
}

/// Update project-level configuration in .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn update_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    // Only the fields the request carries; everything else — issue_tracking, code_hosting, the
    // accent colour — belongs to another handler and has to survive this write.
    mutate_project_config(&conn, |config| {
        config.default_agent = settings.default_agent;
        config.startup_tab = settings.startup_tab;
        config.set_default_workspace_mode(settings.default_workspace_mode);
        true
    })
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_conn(dir: &tempfile::TempDir) -> GitConnection {
        GitConnection::Local {
            path: dir.path().to_str().expect("UTF-8 path").to_string(),
        }
    }

    /// The point of the helper: a second mutation sees what the first wrote, so a caller holding
    /// a snapshot from before the first write cannot restore the field it never knew about.
    #[tokio::test]
    async fn each_mutation_sees_the_previous_one() {
        let dir = tempfile::tempdir().expect("temp directory");
        let conn = local_conn(&dir);

        mutate_project_config(&conn, |config| {
            config.accent_color = Some("120".to_string());
            true
        })
        .await
        .expect("write the colour");

        mutate_project_config(&conn, |config| {
            assert_eq!(config.accent_color.as_deref(), Some("120"));
            config.set_default_workspace_mode(
                crate::task::models::WorkspaceMode::RepositoryDirectory,
            );
            true
        })
        .await
        .expect("write the workspace default");

        let stored: ProjectConfig = read_maestro_json(&conn, SETTINGS_FILE).await;
        assert_eq!(stored.accent_color.as_deref(), Some("120"));
        assert_eq!(
            stored.default_workspace_mode(),
            crate::task::models::WorkspaceMode::RepositoryDirectory
        );
    }

    /// A detector that declines to apply must not touch the file — including not creating one
    /// for a project that has never written settings.
    #[tokio::test]
    async fn declining_to_change_anything_writes_nothing() {
        let dir = tempfile::tempdir().expect("temp directory");
        let conn = local_conn(&dir);

        let applied = mutate_project_config(&conn, |_| false).await.expect("no-op mutation");
        assert!(!applied);
        assert!(!dir.path().join(".maestro").join(SETTINGS_FILE).exists());

        mutate_project_config(&conn, |config| {
            config.default_agent = Some("claude-acp".to_string());
            true
        })
        .await
        .expect("write the agent");
        let after_write = std::fs::read(dir.path().join(".maestro").join(SETTINGS_FILE))
            .expect("read settings");

        let applied = mutate_project_config(&conn, |_| false).await.expect("no-op mutation");
        assert!(!applied);
        assert_eq!(
            std::fs::read(dir.path().join(".maestro").join(SETTINGS_FILE)).expect("re-read"),
            after_write
        );
    }
}
