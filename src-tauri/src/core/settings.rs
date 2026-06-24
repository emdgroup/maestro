use rusqlite::Connection;

use crate::models::{AppSettings, ActivityVisibility, EnterKeyBehavior, TerminalColorMode};

/// Load application settings from the database
///
/// Queries the settings table and reconstructs AppSettings struct.
/// Returns default AppSettings if table is empty.
pub fn load_settings(conn: &Connection) -> Result<AppSettings, String> {
    // Query all settings from the table
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut settings_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let settings_iter = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| format!("Failed to query settings: {}", e))?;

    for result in settings_iter {
        let (key, value) = result
            .map_err(|e| format!("Failed to read setting: {}", e))?;
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

    let thinking_visibility = settings_map
        .get("thinking_visibility")
        .and_then(|v| v.parse::<ActivityVisibility>().ok())
        .unwrap_or_default();

    let tool_call_visibility = settings_map
        .get("tool_call_visibility")
        .and_then(|v| v.parse::<ActivityVisibility>().ok())
        .unwrap_or_default();

    let accent_color = settings_map.get("accent_color").filter(|v| !v.is_empty()).cloned();

    let terminal_color_mode = settings_map
        .get("terminal_color_mode")
        .and_then(|v| v.parse::<TerminalColorMode>().ok())
        .unwrap_or_default();

    let enter_key_behavior = settings_map
        .get("enter_key_behavior")
        .and_then(|v| v.parse::<EnterKeyBehavior>().ok())
        .unwrap_or_default();

    let auto_update = settings_map
        .get("auto_update")
        .map(|v| v == "true")
        .unwrap_or(false);

    Ok(AppSettings {
        theme_preference,
        auto_mode,
        max_concurrent_agents,
        thinking_visibility,
        tool_call_visibility,
        accent_color,
        terminal_color_mode,
        enter_key_behavior,
        updated_at,
        auto_update,
    })
}

/// Save application settings to the database
///
/// Serializes AppSettings to key-value pairs and performs INSERT OR REPLACE
/// into the settings table.
pub fn save_settings(conn: &mut Connection, settings: &AppSettings) -> Result<(), String> {

    // Build key-value pairs for simple string fields
    let auto_mode_str = if settings.auto_mode { "true" } else { "false" };
    let max_concurrent_str = settings.max_concurrent_agents.to_string();
    let thinking_vis = settings.thinking_visibility.to_string();
    let tool_call_vis = settings.tool_call_visibility.to_string();
    let accent_color_str = settings.accent_color.as_deref().unwrap_or("").to_string();
    let terminal_color_mode_str = settings.terminal_color_mode.to_string();
    let enter_key_behavior_str = settings.enter_key_behavior.to_string();
    let auto_update_str = if settings.auto_update { "true" } else { "false" };
    let pairs: Vec<(&str, &str)> = vec![
        ("theme_preference", settings.theme_preference.as_deref().unwrap_or("system")),
        ("auto_mode", auto_mode_str),
        ("max_concurrent_agents", max_concurrent_str.as_str()),
        ("thinking_visibility", thinking_vis.as_str()),
        ("tool_call_visibility", tool_call_vis.as_str()),
        ("accent_color", accent_color_str.as_str()),
        ("terminal_color_mode", terminal_color_mode_str.as_str()),
        ("enter_key_behavior", enter_key_behavior_str.as_str()),
        ("auto_update", auto_update_str),
        ("updated_at", settings.updated_at.as_str()),
    ];

    // Use a transaction for atomic writes
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    for (key, value) in &pairs {
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, value, &settings.updated_at],
        )
        .map_err(|e| format!("Failed to insert setting '{}': {}", key, e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_settings_empty() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        let _settings = load_settings(&conn).unwrap();
    }

    #[test]
    fn test_save_and_load_settings() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        let settings = AppSettings {
            theme_preference: Some("dark".to_string()),
            auto_mode: false,
            max_concurrent_agents: 3,
            thinking_visibility: crate::models::ActivityVisibility::Auto,
            tool_call_visibility: crate::models::ActivityVisibility::Auto,
            accent_color: None,
            terminal_color_mode: crate::models::TerminalColorMode::FollowTheme,
            enter_key_behavior: crate::models::EnterKeyBehavior::SendPrompt,
            updated_at: chrono::Utc::now().to_rfc3339(),
            auto_update: false,
        };

        save_settings(&mut conn, &settings).unwrap();
        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded.theme_preference, settings.theme_preference);
    }
}
