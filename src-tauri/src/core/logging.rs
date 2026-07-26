//! Log sink configuration.
//!
//! This lives in the library rather than `main.rs` because the settings UI has to resolve and
//! report the exact same directory the logger writes to — telling a user the wrong path is worse
//! than telling them nothing.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// Levels offered in the UI, quietest first. `off` is deliberately absent: a user who disables
/// logging cannot produce the report that makes their bug actionable, and the file is capped
/// anyway.
pub const LOG_LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];

/// 5 MB per file, two rotated files kept alongside the live one — a ~15 MB ceiling. The plugin's
/// own default is 40 KB keeping one, which at `trace` holds only the last few seconds and so
/// never contains the event a user is reporting.
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
const ROTATION: RotationStrategy = RotationStrategy::KeepSome(2);

/// The directory the running logger is actually writing to.
///
/// Kept separate from the stored setting because a directory change only takes effect at the next
/// launch. Reporting the newly configured path while the file is still being written elsewhere
/// would send a user looking for their log to an empty folder.
static ACTIVE_DIRECTORY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn active_directory() -> Option<PathBuf> {
    ACTIVE_DIRECTORY.get().cloned()
}

fn parse_level(value: &str) -> Option<log::LevelFilter> {
    value.trim().parse().ok()
}

/// `MAESTRO_LOG` wins over the stored setting so a debugging session does not have to mutate the
/// user's preferences; the stored setting wins over the `info` default.
///
/// An unparseable value in either place falls through to the next source rather than failing, so
/// a typo costs a level rather than a launch.
pub fn effective_level(stored: Option<&str>) -> log::LevelFilter {
    level_from(std::env::var("MAESTRO_LOG").ok().as_deref(), stored)
}

/// Split from `effective_level` so the precedence is testable without mutating the environment,
/// which is process-global and would race against other tests.
fn level_from(env: Option<&str>, stored: Option<&str>) -> log::LevelFilter {
    env.and_then(parse_level)
        .or_else(|| stored.and_then(parse_level))
        .unwrap_or(log::LevelFilter::Info)
}

/// The directory the logger writes to: the user's choice when set, otherwise Tauri's own
/// `app_log_dir()` verbatim. The per-platform layout is Tauri's to decide, not ours.
pub fn resolve_log_dir(custom: Option<&str>, os_log_dir: &Path) -> PathBuf {
    match custom.map(str::trim).filter(|value| !value.is_empty()) {
        Some(custom) => PathBuf::from(custom),
        None => os_log_dir.to_path_buf(),
    }
}

/// Where logs will go for the current settings, for display in the UI.
pub fn current_log_dir<R: Runtime>(
    app: &AppHandle<R>,
    custom: Option<&str>,
) -> Result<PathBuf, String> {
    let os_log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve the OS log directory: {}", e))?;
    Ok(resolve_log_dir(custom, &os_log_dir))
}

/// Install the logger and register the plugin's webview-side command.
///
/// Deferred to `setup()` rather than the builder chain because the level and directory come from
/// the settings table, which is only readable once the database is open. The cost is that records
/// emitted before this point — other plugins' initialisation — are dropped.
pub fn install<R: Runtime>(
    app: &AppHandle<R>,
    directory: &Path,
    level: log::LevelFilter,
) -> Result<(), String> {
    // fern's own filtering is fixed once built, so our crates are let through at `trace` here and
    // gated by `log::set_max_level` below instead. That indirection is what lets the user change
    // the level without restarting. Dependencies keep a hard `warn` ceiling: at `debug` keyring
    // narrates every credential lookup and rustls every handshake, which buries our own lines.
    let (plugin, _plugin_max_level, logger) = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Stderr))
        .target(Target::new(TargetKind::Folder {
            path: directory.to_path_buf(),
            file_name: None,
        }))
        .level(log::LevelFilter::Warn)
        .level_for("maestro", log::LevelFilter::Trace)
        .level_for("maestro_lib", log::LevelFilter::Trace)
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(ROTATION)
        .split(app)
        .map_err(|e| format!("Failed to open the log directory {}: {}", directory.display(), e))?;

    log::set_boxed_logger(logger)
        .map_err(|e| format!("A logger is already installed: {}", e))?;
    set_level(level);

    if ACTIVE_DIRECTORY.set(directory.to_path_buf()).is_err() {
        return Err("A log directory is already active".to_string());
    }

    app.plugin(plugin)
        .map_err(|e| format!("Failed to register the log plugin: {}", e))
}

/// Change the active level. Takes effect on the next log call — the `log` macros consult this
/// before evaluating their arguments, so lowering it also stops paying to format the messages.
pub fn set_level(level: log::LevelFilter) {
    log::set_max_level(level);
}

/// Apply a stored level string, ignoring it if it does not parse. Returns the level in force.
pub fn apply_stored_level(stored: Option<&str>) -> log::LevelFilter {
    let level = effective_level(stored);
    set_level(level);
    level
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::LevelFilter;

    /// Tauri's per-platform layout is passed through untouched, including macOS's
    /// `~/Library/Logs/<identifier>` which has no trailing `logs` segment.
    #[test]
    fn the_os_log_directory_is_used_verbatim() {
        for os_dir in [
            Path::new("/home/alice/.local/share/com.maestro.app/logs"),
            Path::new("/Users/alice/Library/Logs/com.maestro.app"),
        ] {
            assert_eq!(resolve_log_dir(None, os_dir), os_dir);
        }
    }

    #[test]
    fn a_custom_directory_overrides_the_default() {
        assert_eq!(
            resolve_log_dir(Some("/var/log/maestro"), Path::new("/ignored")),
            Path::new("/var/log/maestro")
        );
    }

    /// A blank setting is what the database holds for "unset". Treating it as a path would drop the
    /// log file in the process working directory.
    #[test]
    fn blank_and_whitespace_directories_fall_back_to_the_default() {
        let os_dir = Path::new("/home/alice/.local/share/com.maestro.app/logs");
        assert_eq!(resolve_log_dir(Some(""), os_dir), os_dir);
        assert_eq!(resolve_log_dir(Some("   "), os_dir), os_dir);
    }

    #[test]
    fn a_custom_directory_is_trimmed() {
        assert_eq!(
            resolve_log_dir(Some("  /var/log/maestro  "), Path::new("/ignored")),
            Path::new("/var/log/maestro")
        );
    }

    #[test]
    fn the_environment_overrides_the_stored_level() {
        assert_eq!(level_from(Some("trace"), Some("error")), LevelFilter::Trace);
    }

    #[test]
    fn the_stored_level_is_used_when_the_environment_is_unset() {
        assert_eq!(level_from(None, Some("debug")), LevelFilter::Debug);
    }

    #[test]
    fn levels_default_to_info_when_nothing_is_set() {
        assert_eq!(level_from(None, None), LevelFilter::Info);
    }

    /// A typo must cost a level, not a launch — and must not mask a valid stored value.
    #[test]
    fn unparseable_levels_fall_through_to_the_next_source() {
        assert_eq!(level_from(Some("debgu"), Some("warn")), LevelFilter::Warn);
        assert_eq!(level_from(Some("debgu"), None), LevelFilter::Info);
        assert_eq!(level_from(None, Some("nonsense")), LevelFilter::Info);
    }

    #[test]
    fn levels_are_case_insensitive_and_tolerate_padding() {
        assert_eq!(level_from(Some(" TRACE "), None), LevelFilter::Trace);
    }

    /// Every level offered in the UI must be one the backend actually parses.
    #[test]
    fn every_offered_level_parses() {
        for level in LOG_LEVELS {
            assert!(parse_level(level).is_some(), "{level} is offered but does not parse");
        }
    }

    /// What `save_settings` relies on for the level to change without a restart: the level has to
    /// reach the global gate the `log` macros consult, not just fern's own filtering.
    ///
    /// Deliberately does not assert which level a stored string maps to — `MAESTRO_LOG` would win
    /// if it were set in the test environment. Precedence is covered by the `level_from` tests.
    #[test]
    fn applying_a_stored_level_moves_the_global_gate() {
        let restore = log::max_level();

        for stored in ["error", "debug", "trace"] {
            let expected = effective_level(Some(stored));
            assert_eq!(apply_stored_level(Some(stored)), expected);
            assert_eq!(log::max_level(), expected, "the global gate must follow the setting");
        }

        set_level(restore);
    }
}
