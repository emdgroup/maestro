//! Extra workspace roots handed to an agent alongside the session's own directory.
//!
//! The paths arrive verbatim from the project's `.maestro/settings.json` because Tauri cannot
//! resolve them: for an SSH or WSL project `~` and the filesystem belong to this machine, not
//! that one. So expansion, validation and the existence check all happen here.

use std::path::{Path, PathBuf};

/// Convert configured paths into absolute directories, with a reason for each one dropped.
///
/// Everything is checked rather than trusted, because a bad root is otherwise reported by the
/// agent — if at all — as an error that points nowhere near the settings file that caused it.
pub(crate) fn resolve_additional_directories(
    raw: &[String],
    supported: bool,
    home: Option<&str>,
) -> (Vec<PathBuf>, Vec<String>) {
    if raw.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if !supported {
        return (
            Vec::new(),
            vec![format!(
                "this agent does not support additional workspace roots, so {} were not sent",
                raw.len()
            )],
        );
    }

    let mut dirs = Vec::new();
    let mut skipped = Vec::new();
    for entry in raw {
        match resolve_one(entry, home) {
            Ok(path) => dirs.push(path),
            Err(reason) => skipped.push(format!("{entry}: {reason}")),
        }
    }
    (dirs, skipped)
}

fn resolve_one(entry: &str, home: Option<&str>) -> Result<PathBuf, String> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return Err("is empty".to_string());
    }

    let expanded = if trimmed == "~" || trimmed.starts_with("~/") {
        let home = home.ok_or("starts with ~ but no home directory is set")?;
        // `~` alone is the home directory; `~/x` joins onto it. `~user` is deliberately not
        // supported — resolving another user's home needs passwd lookups for a case nobody has
        // asked for, and silently treating it as a relative path would be worse.
        match trimmed.strip_prefix("~/") {
            Some(rest) => Path::new(home).join(rest),
            None => PathBuf::from(home),
        }
    } else {
        PathBuf::from(trimmed)
    };

    if !expanded.is_absolute() {
        return Err("is not an absolute path".to_string());
    }
    if !expanded.is_dir() {
        return Err("is not a directory on this machine".to_string());
    }
    Ok(expanded)
}

/// Read the current user's home directory, for expanding a leading `~`.
pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|h| !h.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory that certainly exists, so the existence check is not what a test trips on.
    fn real_dir() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[test]
    fn absolute_existing_directories_pass_through() {
        let dir = real_dir();
        let (dirs, skipped) =
            resolve_additional_directories(std::slice::from_ref(&dir), true, None);
        assert_eq!(dirs, vec![PathBuf::from(dir)]);
        assert!(skipped.is_empty());
    }

    #[test]
    fn empty_input_asks_nothing_of_the_agent() {
        let (dirs, skipped) = resolve_additional_directories(&[], false, None);
        assert!(dirs.is_empty());
        assert!(skipped.is_empty(), "an unsupporting agent with no roots is not worth a warning");
    }

    #[test]
    fn unsupported_agent_drops_everything_with_one_reason() {
        let (dirs, skipped) =
            resolve_additional_directories(&[real_dir(), real_dir()], false, None);
        assert!(dirs.is_empty());
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].contains("does not support"));
    }

    #[test]
    fn tilde_expands_against_the_supplied_home() {
        let home = real_dir();
        let (dirs, skipped) = resolve_additional_directories(&["~".to_string()], true, Some(&home));
        assert_eq!(dirs, vec![PathBuf::from(&home)]);
        assert!(skipped.is_empty());
    }

    #[test]
    fn tilde_slash_joins_onto_home() {
        let home = std::env::temp_dir();
        let sub = home.join("maestro-roots-test");
        std::fs::create_dir_all(&sub).expect("create temp subdirectory");
        let (dirs, skipped) = resolve_additional_directories(
            &["~/maestro-roots-test".to_string()],
            true,
            Some(&home.to_string_lossy()),
        );
        assert_eq!(dirs, vec![sub], "{skipped:?}");
    }

    #[test]
    fn tilde_without_a_home_is_reported_not_guessed() {
        let (dirs, skipped) = resolve_additional_directories(&["~/x".to_string()], true, None);
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("no home directory"), "{skipped:?}");
    }

    #[test]
    fn other_users_home_is_not_silently_read_as_relative() {
        let (dirs, skipped) =
            resolve_additional_directories(&["~someone/x".to_string()], true, Some("/home/me"));
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("not an absolute path"), "{skipped:?}");
    }

    #[test]
    fn relative_paths_are_rejected() {
        let (dirs, skipped) =
            resolve_additional_directories(&["../sibling".to_string()], true, None);
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("not an absolute path"));
    }

    #[test]
    fn a_path_that_does_not_exist_is_reported_here_not_by_the_agent() {
        let missing = std::env::temp_dir().join("maestro-definitely-absent-4a3b");
        let (dirs, skipped) = resolve_additional_directories(
            &[missing.to_string_lossy().into_owned()],
            true,
            None,
        );
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("not a directory"), "{skipped:?}");
    }

    #[test]
    fn a_file_is_not_accepted_as_a_root() {
        let file = std::env::temp_dir().join("maestro-roots-test-file");
        std::fs::write(&file, b"x").expect("write temp file");
        let (dirs, skipped) =
            resolve_additional_directories(&[file.to_string_lossy().into_owned()], true, None);
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("not a directory"), "{skipped:?}");
    }

    #[test]
    fn one_bad_root_does_not_drop_the_others() {
        let (dirs, skipped) = resolve_additional_directories(
            &[real_dir(), "relative".to_string()],
            true,
            None,
        );
        assert_eq!(dirs.len(), 1);
        assert_eq!(skipped.len(), 1);
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        let padded = format!("  {}  ", real_dir());
        let (dirs, skipped) = resolve_additional_directories(&[padded], true, None);
        assert_eq!(dirs.len(), 1, "{skipped:?}");
    }

    #[test]
    fn a_blank_entry_is_reported_rather_than_resolving_to_cwd() {
        let (dirs, skipped) = resolve_additional_directories(&["   ".to_string()], true, None);
        assert!(dirs.is_empty());
        assert!(skipped[0].contains("is empty"), "{skipped:?}");
    }
}
