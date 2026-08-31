use rusqlite::{Connection, OptionalExtension};

use crate::models::{AgentStreamWidth, AppSettings, ActivityVisibility, ConnectionCapacitySettings, EnterKeyBehavior, NewProjectColor, TerminalColorMode};

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

    let thinking_visibility = settings_map
        .get("thinking_visibility")
        .and_then(|v| v.parse::<ActivityVisibility>().ok())
        .unwrap_or_default();

    let tool_call_visibility = settings_map
        .get("tool_call_visibility")
        .and_then(|v| v.parse::<ActivityVisibility>().ok())
        .unwrap_or_default();

    let accent_color = settings_map.get("accent_color").filter(|v| !v.is_empty()).cloned();

    let new_project_color = settings_map
        .get("new_project_color")
        .and_then(|v| v.parse::<NewProjectColor>().ok())
        .unwrap_or_default();

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

    // Absent means frameless: the app ships with its own title bar, and the OS frame is opt-in.
    let native_window_frame = settings_map
        .get("native_window_frame")
        .map(|v| v == "true")
        .unwrap_or(false);

    let ui_scale = settings_map.get("ui_scale").filter(|v| !v.is_empty()).cloned();
    let log_level = settings_map.get("log_level").filter(|v| !v.is_empty()).cloned();
    let log_directory = settings_map.get("log_directory").filter(|v| !v.is_empty()).cloned();

    Ok(AppSettings {
        theme_preference,
        auto_mode,
        thinking_visibility,
        tool_call_visibility,
        accent_color,
        new_project_color,
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
        native_window_frame,
    })
}

/// Save application settings to the database
///
/// Serializes AppSettings to key-value pairs and performs INSERT OR REPLACE
/// into the settings table.
pub fn save_settings(conn: &mut Connection, settings: &AppSettings) -> Result<(), String> {

    // Build key-value pairs for simple string fields
    let auto_mode_str = if settings.auto_mode { "true" } else { "false" };
    let thinking_vis = settings.thinking_visibility.to_string();
    let tool_call_vis = settings.tool_call_visibility.to_string();
    let accent_color_str = settings.accent_color.as_deref().unwrap_or("").to_string();
    let new_project_color_str = settings.new_project_color.to_string();
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
    let native_window_frame_str = if settings.native_window_frame { "true" } else { "false" };
    let pairs: Vec<(&str, &str)> = vec![
        ("theme_preference", settings.theme_preference.as_deref().unwrap_or("system")),
        ("auto_mode", auto_mode_str),
        ("thinking_visibility", thinking_vis.as_str()),
        ("tool_call_visibility", tool_call_vis.as_str()),
        ("accent_color", accent_color_str.as_str()),
        ("new_project_color", new_project_color_str.as_str()),
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
        ("native_window_frame", native_window_frame_str),
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

/// The agent limit in force on one connection.
///
/// A connection with no row has never been configured and takes the defaults, which is also what a
/// stored mode we cannot parse falls back to — the same shape as `new_project_color` above, and for
/// the same reason: a limit that refuses to load would stop the queue entirely.
pub fn load_connection_capacity(
    conn: &Connection,
    key: crate::acp::ConnectionKey,
) -> Result<ConnectionCapacitySettings, String> {
    let row = conn
        .query_row(
            "SELECT concurrency_mode, max_concurrent_agents FROM connection_settings WHERE connection_key = ?",
            [key.storage_id()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to query connection settings: {}", e))?;

    let Some((mode, max_concurrent_agents)) = row else {
        return Ok(ConnectionCapacitySettings::default());
    };

    Ok(ConnectionCapacitySettings {
        concurrency_mode: mode
            .parse::<crate::execution::capacity::ConcurrencyMode>()
            .unwrap_or_default(),
        max_concurrent_agents,
    })
}

pub fn save_connection_capacity(
    conn: &Connection,
    key: crate::acp::ConnectionKey,
    settings: &ConnectionCapacitySettings,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO connection_settings \
         (connection_key, concurrency_mode, max_concurrent_agents, updated_at) \
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            key.storage_id(),
            settings.concurrency_mode.as_str(),
            settings.max_concurrent_agents,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| format!("Failed to save connection settings: {}", e))?;

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
            thinking_visibility: crate::models::ActivityVisibility::Auto,
            tool_call_visibility: crate::models::ActivityVisibility::Auto,
            accent_color: None,
            new_project_color: crate::models::NewProjectColor::Global,
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
            native_window_frame: true,
        };

        save_settings(&mut conn, &settings).unwrap();
        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded.theme_preference, settings.theme_preference);
        assert_eq!(loaded.log_level, settings.log_level);
        assert_eq!(loaded.log_directory, settings.log_directory);
        assert_eq!(loaded.new_project_color, crate::models::NewProjectColor::Global);
        assert!(!loaded.notify_on_done);
        assert!(loaded.notify_on_input_needed);
        assert!(!loaded.notify_on_failure);
        // Not the default, so a round trip that dropped the key would still look like a pass.
        assert!(loaded.native_window_frame);
    }

    /// An unparseable stored value must fall back to the default rather than erroring, matching
    /// how `log_level` behaves.
    #[test]
    fn unparseable_new_project_color_falls_back_to_default() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('new_project_color', 'rainbow', '2026-01-01')",
            [],
        )
        .unwrap();

        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded.new_project_color, crate::models::NewProjectColor::Auto);
    }

    /// The whole point of the per-connection table: two hosts hold two different limits, and
    /// neither is disturbed by the other being written.
    #[test]
    fn each_connection_holds_its_own_limit() {
        use crate::acp::ConnectionKey;
        use crate::execution::capacity::ConcurrencyMode;

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        save_connection_capacity(
            &conn,
            ConnectionKey::Local,
            &ConnectionCapacitySettings {
                concurrency_mode: ConcurrencyMode::Hard,
                max_concurrent_agents: 8,
            },
        )
        .unwrap();
        save_connection_capacity(
            &conn,
            ConnectionKey::Ssh { id: 3 },
            &ConnectionCapacitySettings {
                concurrency_mode: ConcurrencyMode::Auto,
                max_concurrent_agents: 2,
            },
        )
        .unwrap();

        let local = load_connection_capacity(&conn, ConnectionKey::Local).unwrap();
        assert_eq!(local.concurrency_mode, ConcurrencyMode::Hard);
        assert_eq!(local.max_concurrent_agents, 8);

        let remote = load_connection_capacity(&conn, ConnectionKey::Ssh { id: 3 }).unwrap();
        assert_eq!(remote.concurrency_mode, ConcurrencyMode::Auto);
        assert_eq!(remote.max_concurrent_agents, 2);
    }

    /// A connection nobody has configured estimates from memory rather than sitting at a fixed
    /// number, which is the behaviour the setting exists to provide.
    #[test]
    fn an_unconfigured_connection_defaults_to_the_memory_estimate() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        let loaded = load_connection_capacity(&conn, crate::acp::ConnectionKey::Wsl { id: 1 }).unwrap();

        assert_eq!(loaded.concurrency_mode, crate::execution::capacity::ConcurrencyMode::Auto);
        assert_eq!(loaded.max_concurrent_agents, 3);
    }

    /// An unparseable stored mode must fall back rather than error: a limit that refuses to load
    /// would stop the queue draining at all.
    #[test]
    fn unparseable_connection_mode_falls_back_to_the_default() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO connection_settings (connection_key, concurrency_mode, max_concurrent_agents, updated_at) \
             VALUES ('local', 'Elastic', 5, '2026-01-01')",
            [],
        )
        .unwrap();

        let loaded = load_connection_capacity(&conn, crate::acp::ConnectionKey::Local).unwrap();

        assert_eq!(loaded.concurrency_mode, crate::execution::capacity::ConcurrencyMode::Auto);
        // The number is still the stored one — only the unreadable field falls back.
        assert_eq!(loaded.max_concurrent_agents, 5);
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
