use rusqlite::Connection;

use crate::models::{AgentStreamWidth, AppSettings, ActivityVisibility, EnterKeyBehavior, TerminalColorMode};

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

    let concurrency_mode = settings_map
        .get("concurrency_mode")
        .and_then(|v| v.parse::<crate::execution::capacity::ConcurrencyMode>().ok())
        .unwrap_or_default();

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

    let agent_stream_width = settings_map
        .get("agent_stream_width")
        .and_then(|v| v.parse::<AgentStreamWidth>().ok())
        .unwrap_or_default();

    let notify_on_done = settings_map
        .get("notify_on_done")
        .map(|v| v == "true")
        .unwrap_or(false);

    let notify_on_input_needed = settings_map
        .get("notify_on_input_needed")
        .map(|v| v == "true")
        .unwrap_or(false);

    let notify_on_failure = settings_map
        .get("notify_on_failure")
        .map(|v| v == "true")
        .unwrap_or(false);

    let ui_scale = settings_map.get("ui_scale").filter(|v| !v.is_empty()).cloned();
    let log_level = settings_map.get("log_level").filter(|v| !v.is_empty()).cloned();
    let log_directory = settings_map.get("log_directory").filter(|v| !v.is_empty()).cloned();

    Ok(AppSettings {
        theme_preference,
        auto_mode,
        max_concurrent_agents,
        concurrency_mode,
        thinking_visibility,
        tool_call_visibility,
        accent_color,
        terminal_color_mode,
        enter_key_behavior,
        agent_stream_width,
        updated_at,
        auto_update,
        ui_scale,
        log_level,
        log_directory,
        notify_on_done,
        notify_on_input_needed,
        notify_on_failure,
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
    let concurrency_mode_str = settings.concurrency_mode.as_str();
    let thinking_vis = settings.thinking_visibility.to_string();
    let tool_call_vis = settings.tool_call_visibility.to_string();
    let accent_color_str = settings.accent_color.as_deref().unwrap_or("").to_string();
    let terminal_color_mode_str = settings.terminal_color_mode.to_string();
    let enter_key_behavior_str = settings.enter_key_behavior.to_string();
    let agent_stream_width_str = settings.agent_stream_width.to_string();
    let auto_update_str = if settings.auto_update { "true" } else { "false" };
    let ui_scale_str = settings.ui_scale.as_deref().unwrap_or("").to_string();
    let log_level_str = settings.log_level.as_deref().unwrap_or("").to_string();
    let log_directory_str = settings.log_directory.as_deref().unwrap_or("").to_string();
    let notify_on_done_str = if settings.notify_on_done { "true" } else { "false" };
    let notify_on_input_needed_str = if settings.notify_on_input_needed { "true" } else { "false" };
    let notify_on_failure_str = if settings.notify_on_failure { "true" } else { "false" };
    let pairs: Vec<(&str, &str)> = vec![
        ("theme_preference", settings.theme_preference.as_deref().unwrap_or("system")),
        ("auto_mode", auto_mode_str),
        ("max_concurrent_agents", max_concurrent_str.as_str()),
        ("concurrency_mode", concurrency_mode_str),
        ("thinking_visibility", thinking_vis.as_str()),
        ("tool_call_visibility", tool_call_vis.as_str()),
        ("accent_color", accent_color_str.as_str()),
        ("terminal_color_mode", terminal_color_mode_str.as_str()),
        ("enter_key_behavior", enter_key_behavior_str.as_str()),
        ("agent_stream_width", agent_stream_width_str.as_str()),
        ("auto_update", auto_update_str),
        ("ui_scale", ui_scale_str.as_str()),
        ("log_level", log_level_str.as_str()),
        ("log_directory", log_directory_str.as_str()),
        ("notify_on_done", notify_on_done_str),
        ("notify_on_input_needed", notify_on_input_needed_str),
        ("notify_on_failure", notify_on_failure_str),
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
            concurrency_mode: crate::execution::capacity::ConcurrencyMode::Auto,
            thinking_visibility: crate::models::ActivityVisibility::Auto,
            tool_call_visibility: crate::models::ActivityVisibility::Auto,
            accent_color: None,
            terminal_color_mode: crate::models::TerminalColorMode::FollowTheme,
            enter_key_behavior: crate::models::EnterKeyBehavior::SendPrompt,
            agent_stream_width: crate::models::AgentStreamWidth::Full,
            updated_at: chrono::Utc::now().to_rfc3339(),
            auto_update: false,
            ui_scale: None,
            log_level: Some("debug".to_string()),
            log_directory: Some("/tmp/maestro-logs".to_string()),
            notify_on_done: false,
            notify_on_input_needed: true,
            notify_on_failure: false,
        };

        save_settings(&mut conn, &settings).unwrap();
        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded.theme_preference, settings.theme_preference);
        assert_eq!(loaded.log_level, settings.log_level);
        assert_eq!(loaded.log_directory, settings.log_directory);
        assert!(!loaded.notify_on_done);
        assert!(loaded.notify_on_input_needed);
        assert!(!loaded.notify_on_failure);
        // Not the default, so a round trip that silently dropped it would look like a pass.
        assert_eq!(loaded.concurrency_mode, crate::execution::capacity::ConcurrencyMode::Auto);
    }

    /// An unset directory must come back as `None`, not `Some("")` — the empty string would be
    /// resolved as a path and send the log file to the process working directory.
    #[test]
    fn unset_log_settings_round_trip_as_none() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        save_settings(&mut conn, &AppSettings::default()).unwrap();
        let loaded = load_settings(&conn).unwrap();

        assert_eq!(loaded.log_level, None);
        assert_eq!(loaded.log_directory, None);
    }
}
