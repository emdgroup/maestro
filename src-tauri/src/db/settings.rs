use rusqlite::Connection;

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

    let updated_at = settings_map
        .get("updated_at")
        .cloned()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let theme_preference = settings_map.get("theme_preference").cloned();

    let auto_mode = settings_map
        .get("auto_mode")
        .map(|v| v == "true")
        .unwrap_or(false);

    let max_concurrent_agents = settings_map
        .get("max_concurrent_agents")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(3);

    Ok(AppSettings {
        theme_preference,
        auto_mode,
        max_concurrent_agents,
        updated_at,
    })
}

/// Save application settings to the database
///
/// Serializes AppSettings to key-value pairs and performs INSERT OR REPLACE
/// into the settings table.
pub fn save_settings(conn: &mut Connection, settings: &AppSettings) -> Result<(), AppError> {

    // Build key-value pairs for simple string fields
    let auto_mode_str = if settings.auto_mode { "true" } else { "false" };
    let max_concurrent_str = settings.max_concurrent_agents.to_string();
    let pairs = vec![
        ("theme_preference", settings.theme_preference.as_ref().map(|s| s.as_str()).unwrap_or("system")),
        ("auto_mode", auto_mode_str),
        ("max_concurrent_agents", max_concurrent_str.as_str()),
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

        let _settings = load_settings(&conn).unwrap();
    }

    #[test]
    fn test_save_and_load_settings() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::initialize_schema(&conn).unwrap();

        let settings = AppSettings {
            theme_preference: Some("dark".to_string()),
            auto_mode: false,
            max_concurrent_agents: 3,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        save_settings(&mut conn, &settings).unwrap();
        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded.theme_preference, settings.theme_preference);
    }
}
