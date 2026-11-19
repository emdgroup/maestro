use crate::connectivity::GitConnection;

const DEFAULT_COMMIT_TEMPLATE: &str = "\
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.";

/// Read a JSON document out of the project's `.maestro/` folder, wherever the project lives.
///
/// A missing, unreadable or unparseable file yields the default value: every caller treats a
/// project that has never written the file as one holding defaults, which is not an error.
pub async fn read_maestro_json<T: serde::de::DeserializeOwned + Default>(
    conn: &GitConnection,
    file_name: &str,
) -> T {
    let path = format!("{}/.maestro/{}", conn.path(), file_name);

    let Ok(text) = crate::connectivity::files::read_text(conn, &path).await else {
        return T::default();
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
    let json =
        serde_json::to_string_pretty(value).map_err(|e| format!("Serialization failed: {}", e))?;
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

    crate::connectivity::files::create_dir_all(conn, &dir).await?;
    crate::connectivity::files::write_text(conn, &path, contents).await
}

/// Give a project the `.maestro/` folder and default commit template it expects, on whichever
/// machine it lives.
///
/// The template is only written when absent, so a user's edits survive reopening the project.
pub async fn ensure_project_storage(conn: &GitConnection) -> Result<(), String> {
    let dir = format!("{}/.maestro", conn.path());
    crate::connectivity::files::create_dir_all(conn, &dir).await?;

    // Best effort: a project that is not a git repository has nothing to exclude from, and the
    // folder is still perfectly usable without it.
    if let Err(e) = exclude_maestro_from_git(conn).await {
        log::warn!("[project] could not exclude .maestro/ from git: {e}");
    }

    if crate::connectivity::files::exists(conn, &format!("{dir}/commit-template.txt")).await {
        return Ok(());
    }
    write_maestro_file(conn, "commit-template.txt", DEFAULT_COMMIT_TEMPLATE).await
}

/// Whether a path git printed is already absolute, on either kind of host.
fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/') || path.as_bytes().get(1) == Some(&b':')
}

/// Keep `.maestro/` out of git, for the project and every worktree cut from it.
///
/// `info/exclude` rather than `.gitignore`: the canvases, imports and settings under `.maestro/`
/// are this machine's, and committing an ignore rule for them would push a local arrangement into
/// everyone else's repository. `info/` lives in the *common* git directory, so one write covers the
/// main checkout and all of its worktrees at once.
async fn exclude_maestro_from_git(conn: &GitConnection) -> Result<(), String> {
    const RULE: &str = ".maestro/";

    let common_dir =
        crate::git::exec::run_git_in_dir(conn, conn.path(), &["rev-parse", "--git-common-dir"])
            .await?;
    let common_dir = common_dir.trim();
    if common_dir.is_empty() {
        return Err("git did not report a common directory".to_string());
    }
    // Relative (`.git`) when git is run from the main checkout, absolute from a worktree.
    let common_dir = if is_absolute_path(common_dir) {
        common_dir.to_string()
    } else {
        format!("{}/{common_dir}", conn.path())
    };

    let path = format!("{common_dir}/info/exclude");
    let existing = if crate::connectivity::files::exists(conn, &path).await {
        crate::connectivity::files::read_text(conn, &path).await?
    } else {
        crate::connectivity::files::create_dir_all(conn, &format!("{common_dir}/info")).await?;
        String::new()
    };
    if existing.lines().any(|line| line.trim() == RULE) {
        return Ok(());
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(RULE);
    next.push('\n');
    crate::connectivity::files::write_text(conn, &path, &next).await
}

#[cfg(test)]
mod tests {
    use super::is_absolute_path;
    use maestro_protocol::fs::atomic_write;

    /// `rev-parse --git-common-dir` answers `.git` from the main checkout and an absolute path
    /// from a worktree. Treating the relative form as absolute writes the exclude file to `/info`.
    #[test]
    fn git_common_dir_forms_are_told_apart() {
        assert!(!is_absolute_path(".git"));
        assert!(!is_absolute_path("../.git"));
        assert!(is_absolute_path("/home/u/proj/.git"));
        assert!(is_absolute_path("C:/Users/u/proj/.git"));
    }

    #[test]
    fn atomic_write_replaces_existing_contents_without_leaving_a_temp_file() {
        let dir = tempfile::tempdir().expect("temp directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").expect("initial write");

        atomic_write(&path, b"new contents").expect("atomic replacement");

        assert_eq!(
            std::fs::read(&path).expect("read replacement"),
            b"new contents"
        );
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("list directory")
                .count(),
            1
        );
    }

    #[test]
    fn atomic_write_cleans_up_when_replacement_fails() {
        let dir = tempfile::tempdir().expect("temp directory");
        let path = dir.path().join("state.json");
        std::fs::create_dir(&path).expect("destination directory");

        assert!(atomic_write(&path, b"new contents").is_err());

        assert!(path.is_dir(), "the original destination must remain intact");
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("list directory")
                .count(),
            1
        );
    }
}
