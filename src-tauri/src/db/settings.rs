use rusqlite::Connection;
use serde_json;

use crate::models::AppSettings;
use crate::error::AppError;

/// Load application settings from the database
///
/// Queries the settings table and reconstructs AppSettings struct.
/// Returns default AppSettings if table is empty.
pub fn load_settings(conn: &Connection) -> Result<AppSettings, AppError> {
    // Query all settings from the table
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|e| AppError::DatabaseError(format!("Failed to prepare query: {}", e)))?;

    let mut settings_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let settings_iter = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| AppError::DatabaseError(format!("Failed to query settings: {}", e)))?;

    for result in settings_iter {
        let (key, value) = result
            .map_err(|e| AppError::DatabaseError(format!("Failed to read setting: {}", e)))?;
        settings_map.insert(key, value);
    }

    // If no settings exist, return default
    if settings_map.is_empty() {
        return Ok(AppSettings::default());
    }

    // Build AppSettings from map
    let project_path = settings_map.get("project_path").and_then(|v| {
        if v == "null" || v.is_empty() {
            None
        } else {
            Some(v.clone())
        }
    });

    let recent_projects: Vec<String> = settings_map
        .get("recent_projects")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let model_default = settings_map
        .get("model_default")
        .cloned()
        .unwrap_or_else(|| "claude-opus-4-5".to_string());

    let mcp_allowlist: Vec<String> = settings_map
        .get("mcp_allowlist")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let skills_default: Vec<String> = settings_map
        .get("skills_default")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let updated_at = settings_map
        .get("updated_at")
        .cloned()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let theme_preference = settings_map.get("theme_preference").cloned();

    Ok(AppSettings {
        project_path,
        recent_projects,
        model_default,
        mcp_allowlist,
        skills_default,
        theme_preference,
        updated_at,
    })
}

/// Save application settings to the database
///
/// Serializes AppSettings to key-value pairs and performs INSERT OR REPLACE
/// into the settings table.
pub fn save_settings(conn: &mut Connection, settings: &AppSettings) -> Result<(), AppError> {
    // Serialize recent_projects to a longer-lived binding
    let recent_projects_json = serde_json::to_string(&settings.recent_projects)
        .map_err(|e| AppError::DatabaseError(format!("Failed to serialize recent_projects: {}", e)))?;

    let mcp_allowlist_json = serde_json::to_string(&settings.mcp_allowlist)
        .map_err(|e| AppError::DatabaseError(format!("Failed to serialize mcp_allowlist: {}", e)))?;

    let skills_default_json = serde_json::to_string(&settings.skills_default)
        .map_err(|e| AppError::DatabaseError(format!("Failed to serialize skills_default: {}", e)))?;

    // Build key-value pairs
    let pairs = vec![
        ("project_path", settings.project_path.as_ref().map(|s| s.as_str()).unwrap_or("null")),
        ("recent_projects", recent_projects_json.as_str()),
        ("model_default", &settings.model_default),
        ("mcp_allowlist", mcp_allowlist_json.as_str()),
        ("skills_default", skills_default_json.as_str()),
        ("theme_preference", settings.theme_preference.as_ref().map(|s| s.as_str()).unwrap_or("system")),
        ("updated_at", &settings.updated_at),
    ];

    // Use a transaction for atomic writes
    let tx = conn
        .transaction()
        .map_err(|e| AppError::DatabaseError(format!("Failed to start transaction: {}", e)))?;

    for (key, value) in &pairs {
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, value, &settings.updated_at],
        )
        .map_err(|e| AppError::DatabaseError(format!("Failed to insert setting '{}': {}", key, e)))?;
    }

    tx.commit()
        .map_err(|e| AppError::DatabaseError(format!("Failed to commit transaction: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_settings_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::initialize_schema(&conn).unwrap();

        let settings = load_settings(&conn).unwrap();
        assert_eq!(settings.project_path, None);
        assert_eq!(settings.recent_projects.len(), 0);
        assert_eq!(settings.model_default, "claude-opus-4-5");
    }

    #[test]
    fn test_save_and_load_settings() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::initialize_schema(&conn).unwrap();

        let settings = AppSettings {
            project_path: Some("/path/to/project".to_string()),
            recent_projects: vec!["/path/to/project".to_string(), "/another/path".to_string()],
            model_default: "claude-opus-4-5".to_string(),
            mcp_allowlist: vec!["filesystem".to_string(), "web".to_string()],
            skills_default: vec!["javascript".to_string()],
            theme_preference: Some("dark".to_string()),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        save_settings(&mut conn, &settings).unwrap();
        let loaded = load_settings(&conn).unwrap();

        assert_eq!(loaded.project_path, settings.project_path);
        assert_eq!(loaded.recent_projects, settings.recent_projects);
        assert_eq!(loaded.model_default, settings.model_default);
        assert_eq!(loaded.mcp_allowlist, settings.mcp_allowlist);
        assert_eq!(loaded.skills_default, settings.skills_default);
        assert_eq!(loaded.theme_preference, settings.theme_preference);
    }
}
