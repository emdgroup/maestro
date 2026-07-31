use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use crate::git::remote::shell_quote;
use crate::models::GitConnection;

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
            // `fs::rename` replaces the destination on every platform we ship — on Windows it
            // is MoveFileExW with MOVEFILE_REPLACE_EXISTING. The temporary always lives in the
            // destination's own directory, so this is a same-volume metadata rename.
            fs::rename(&temp_path, path)
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

/// Build a shell command that writes `contents` to `path` through a temporary file in the same
/// directory, for the SSH, WSL and container paths where we cannot use [`atomic_write`].
///
/// Deliberately plain: no variable assignment, no `$$`, no `trap`. SSH runs this through the
/// user's *login* shell rather than `sh -c`, so anything beyond `&&`, `printf` and redirection
/// would break on a host whose login shell is not POSIX. A fixed temporary name is safe here —
/// `.maestro/` is gitignored, and a leftover from an interrupted write is overwritten by the
/// next one rather than being read by anything.
pub(crate) fn atomic_write_script(dir: &str, path: &str, contents: &str) -> String {
    let temp_path = format!("{path}.tmp");
    format!(
        "mkdir -p {} && printf '%s' {} > {} && mv -f {} {}",
        shell_quote(dir),
        shell_quote(contents),
        shell_quote(&temp_path),
        shell_quote(&temp_path),
        shell_quote(path),
    )
}

/// Read a JSON document out of the project's `.maestro/` folder, wherever the project lives.
///
/// A missing, unreadable or unparseable file yields the default value: every caller treats a
/// project that has never written the file as one holding defaults, which is not an error.
pub async fn read_maestro_json<T: serde::de::DeserializeOwned + Default>(
    conn: &GitConnection,
    file_name: &str,
) -> T {
    let path = format!("{}/.maestro/{}", conn.path(), file_name);

    let text = if matches!(conn, GitConnection::Local { .. }) {
        match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => return T::default(),
        }
    } else {
        match crate::connectivity::exec_channel::run_on(conn, None, "cat", &[&path]).await {
            Ok(output) if output.success() => output.stdout_string(),
            _ => return T::default(),
        }
    };

    serde_json::from_str(&text).unwrap_or_default()
}

/// Replace a JSON document in the project's `.maestro/` folder, wherever the project lives,
/// without exposing a half-written file to a concurrent reader.
pub async fn write_maestro_json<T: serde::Serialize>(
    conn: &GitConnection,
    file_name: &str,
    value: &T,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Serialization failed: {}", e))?;
    write_maestro_file(conn, file_name, &json).await
}

/// Replace a file in the project's `.maestro/` folder, wherever the project lives, without
/// exposing a half-written file to a concurrent reader.
pub async fn write_maestro_file(
    conn: &GitConnection,
    file_name: &str,
    contents: &str,
) -> Result<(), String> {
    let dir = format!("{}/.maestro", conn.path());
    let path = format!("{dir}/{file_name}");

    if matches!(conn, GitConnection::Local { .. }) {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {dir}: {e}"))?;
        return atomic_write(Path::new(&path), contents.as_bytes())
            .map_err(|e| format!("Failed to write {path}: {e}"));
    }

    let script = atomic_write_script(&dir, &path, contents);
    let output = crate::connectivity::exec_channel::run_on(conn, None, "sh", &["-c", &script]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!("Failed to write {path}: {}", output.stderr_string()))
    }
}

/// Give a project the `.maestro/` folder and default commit template it expects, on whichever
/// machine it lives.
///
/// The template is only written when absent, so a user's edits survive reopening the project.
pub async fn ensure_project_storage(conn: &GitConnection) -> Result<(), String> {
    let dir = format!("{}/.maestro", conn.path());
    crate::connectivity::files::create_dir_all(conn, &dir).await?;

    if crate::connectivity::files::exists(conn, &format!("{dir}/commit-template.txt")).await {
        return Ok(());
    }
    write_maestro_file(conn, "commit-template.txt", DEFAULT_COMMIT_TEMPLATE).await
}


#[cfg(test)]
mod tests {
    use super::{atomic_write, atomic_write_script};

    /// SSH runs this through the user's login shell, not `sh -c`, so the script has to stay
    /// within the subset every common login shell understands. An earlier version used
    /// `tmp=…`, `$$` and `trap`, none of which are valid in fish — and every SSH call site
    /// discards the error, so the breakage would have been silent.
    #[test]
    fn atomic_write_script_stays_portable_across_login_shells() {
        let script = atomic_write_script("/srv/p/.maestro", "/srv/p/.maestro/state.json", "{}");

        assert_eq!(
            script,
            "mkdir -p '/srv/p/.maestro' && printf '%s' '{}' > '/srv/p/.maestro/state.json.tmp' \
             && mv -f '/srv/p/.maestro/state.json.tmp' '/srv/p/.maestro/state.json'"
        );
        for construct in ["trap", "$$", "tmp="] {
            assert!(!script.contains(construct), "{construct} is not portable: {script}");
        }
    }

    #[test]
    fn atomic_write_script_quotes_paths_and_contents() {
        let script = atomic_write_script("/a b/.maestro", "/a b/.maestro/s.json", "{\"k\":\"it's\"}");

        assert!(script.contains("'/a b/.maestro/s.json.tmp'"), "{script}");
        assert!(script.contains(r#"'{"k":"it'\''s"}'"#), "{script}");
    }

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
