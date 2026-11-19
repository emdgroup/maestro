//! File browsing over any connection.
//!
//! Every operation is one [`FsOp`], carried out by [`maestro_protocol::fs::apply`]: in this
//! process for a local project, and by the `maestro-server` deployed on the connection's machine
//! for every other kind. One implementation serves every OS, a native Windows host included,
//! where the `ls`, `test`, `find` and `sh` the remote half used to run do not exist.

use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::State;

use maestro_protocol::fs::{FsKind, FsOp, FsReply};

use crate::acp::ConnectionKey;
use crate::connectivity::docker_handlers::run_blocking;
use crate::connectivity::exec_channel::shell_quote;
use crate::connectivity::exec_channel::ExecTarget;
use crate::connectivity::filesystem_handlers::FileEntry;
use crate::connectivity::GitConnection;
use crate::core::AppState;

pub(crate) use maestro_protocol::fs::{BINARY_LIMIT, TEXT_LIMIT};

async fn connect(
    app_state: &AppState,
    connection: ConnectionKey,
    path: String,
) -> Result<GitConnection, String> {
    crate::core::git_connection_for(app_state, path, connection).await
}

/// Carry out one operation on the machine `conn` points at.
async fn fs(conn: &GitConnection, op: FsOp) -> Result<FsReply, String> {
    if matches!(conn, GitConnection::Local { .. }) {
        return run_blocking(move || maestro_protocol::fs::apply(op)).await;
    }
    crate::connectivity::exec_channel::fs(&ExecTarget::of(conn), op).await
}

fn unexpected(reply: FsReply) -> String {
    format!("unexpected reply to a file operation: {reply:?}")
}

async fn done(conn: &GitConnection, op: FsOp) -> Result<(), String> {
    match fs(conn, op).await? {
        FsReply::Done => Ok(()),
        other => Err(unexpected(other)),
    }
}

async fn text(conn: &GitConnection, op: FsOp) -> Result<String, String> {
    match fs(conn, op).await? {
        FsReply::Text(text) => Ok(text),
        other => Err(unexpected(other)),
    }
}

async fn names(conn: &GitConnection, op: FsOp) -> Result<Vec<String>, String> {
    match fs(conn, op).await? {
        FsReply::Names(names) => Ok(names),
        other => Err(unexpected(other)),
    }
}

/// What is at `path`, distinguishing "nothing" from "could not ask": callers that treat an
/// unreachable host as an empty one delete real data.
async fn kind(conn: &GitConnection, path: &str) -> Result<Option<FsKind>, String> {
    match fs(
        conn,
        FsOp::Kind {
            path: path.to_string(),
        },
    )
    .await?
    {
        FsReply::Kind(kind) => Ok(kind),
        other => Err(unexpected(other)),
    }
}

/// The home directory of the user Maestro runs as on the connection's machine.
pub async fn home(conn: &GitConnection) -> Result<String, String> {
    text(conn, FsOp::Home).await
}

/// Whether `path` exists at all on the connection's host, of any kind.
pub async fn exists(conn: &GitConnection, path: &str) -> bool {
    try_exists(conn, path).await.unwrap_or(false)
}

/// Whether `path` is an existing directory on the connection's host, distinguishing "no" from
/// "could not ask".
pub async fn try_dir_exists(conn: &GitConnection, path: &str) -> Result<bool, String> {
    Ok(kind(conn, path).await? == Some(FsKind::Dir))
}

/// [`exists`], distinguishing "no" from "could not ask" as [`try_dir_exists`] does.
pub async fn try_exists(conn: &GitConnection, path: &str) -> Result<bool, String> {
    Ok(kind(conn, path).await?.is_some())
}

/// Whether `path` is an existing directory on the connection's host.
pub async fn dir_exists(conn: &GitConnection, path: &str) -> bool {
    try_dir_exists(conn, path).await.unwrap_or(false)
}

/// Create `path` and any missing parents on the connection's host.
pub async fn create_dir_all(conn: &GitConnection, path: &str) -> Result<(), String> {
    done(
        conn,
        FsOp::CreateDirAll {
            path: path.to_string(),
        },
    )
    .await
}

/// Subdirectories of `path`, hidden ones included — this feeds the directory picker, where a
/// project may well live under a dotted folder.
pub async fn directories(conn: &GitConnection, path: &str) -> Result<Vec<String>, String> {
    names(
        conn,
        FsOp::Directories {
            path: path.to_string(),
        },
    )
    .await
}

/// Directories then files under `path`, each sorted.
pub async fn contents(
    conn: &GitConnection,
    path: &str,
    include_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    let op = FsOp::Contents {
        path: path.to_string(),
        include_hidden,
    };
    match fs(conn, op).await? {
        FsReply::Entries(entries) => Ok(entries
            .into_iter()
            .map(|entry| FileEntry {
                name: entry.name,
                is_dir: entry.is_dir,
            })
            .collect()),
        other => Err(unexpected(other)),
    }
}

/// Every file under `path`, as paths relative to it.
pub async fn workspace_files(
    conn: &GitConnection,
    path: &str,
    include_hidden: bool,
) -> Result<Vec<String>, String> {
    names(
        conn,
        FsOp::WorkspaceFiles {
            path: path.to_string(),
            include_hidden,
        },
    )
    .await
}

/// Where a session's artifacts are written, relative to its working directory. Scanned rather than
/// read off the agent's tool calls: an agent that writes through a script reports no file at all,
/// and a fixed list keeps every ordinary source edit out.
const ARTIFACT_DIRS: [&str; 3] = [".maestro/artifacts", ".planning", ".claude/plans"];

/// A file under one of [`ARTIFACT_DIRS`], and when it last changed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct ArtifactFile {
    /// The root joined to the path under it with `/`, so a caller can strip the root back off.
    pub path: String,
    /// Milliseconds since the epoch, by the host's clock.
    pub modified_ms: f64,
}

/// Files under [`ARTIFACT_DIRS`] in `root` changed since `since_ms`, oldest first: the Overview
/// card shows the tail of the list, so the newest must be last.
pub async fn artifact_files(
    conn: &GitConnection,
    root: &str,
    since_ms: f64,
) -> Result<Vec<ArtifactFile>, String> {
    let op = FsOp::ArtifactFiles {
        root: root.to_string(),
        dirs: ARTIFACT_DIRS.iter().map(|dir| dir.to_string()).collect(),
        since_ms,
    };
    let mut files: Vec<ArtifactFile> = match fs(conn, op).await? {
        FsReply::Artifacts(found) => found
            .into_iter()
            .map(|file| ArtifactFile {
                path: file.path,
                modified_ms: file.modified_ms,
            })
            .collect(),
        other => return Err(unexpected(other)),
    };
    files.sort_by(|a, b| {
        a.modified_ms
            .total_cmp(&b.modified_ms)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(files)
}

/// A file's text content. Binary files and anything over [`TEXT_LIMIT`] are refused.
pub async fn read_text(conn: &GitConnection, path: &str) -> Result<String, String> {
    text(
        conn,
        FsOp::ReadText {
            path: path.to_string(),
        },
    )
    .await
}

/// A file's raw content, base64-encoded. Anything over [`BINARY_LIMIT`] is refused.
pub async fn read_binary(conn: &GitConnection, path: &str) -> Result<String, String> {
    text(
        conn,
        FsOp::ReadBinary {
            path: path.to_string(),
        },
    )
    .await
}

/// Replace a file's text content, without exposing a half-written file to the agent reading it.
pub async fn write_text(conn: &GitConnection, path: &str, contents: &str) -> Result<(), String> {
    // Refused here too, so an oversized file is never sent over the wire to be refused there.
    if contents.len() > TEXT_LIMIT {
        return Err("File too large".to_string());
    }
    done(
        conn,
        FsOp::WriteText {
            path: path.to_string(),
            contents: contents.to_string(),
        },
    )
    .await
}

/// Create an empty file, refusing to truncate one that is already there.
pub async fn create_file(conn: &GitConnection, path: &str) -> Result<(), String> {
    done(
        conn,
        FsOp::CreateFile {
            path: path.to_string(),
        },
    )
    .await
}

/// Create a single directory. Unlike [`create_dir_all`] an existing path is an error, because the
/// caller is a user typing a new name rather than code ensuring a layout.
pub async fn create_directory(conn: &GitConnection, path: &str) -> Result<(), String> {
    done(
        conn,
        FsOp::CreateDir {
            path: path.to_string(),
        },
    )
    .await
}

/// Move a file or directory, refusing to replace anything already at the destination.
pub async fn rename_path(conn: &GitConnection, from: &str, to: &str) -> Result<(), String> {
    done(
        conn,
        FsOp::Rename {
            from: from.to_string(),
            to: to.to_string(),
        },
    )
    .await
}

/// Delete a file, or a directory and everything under it when `recursive` is set.
pub async fn delete_path(conn: &GitConnection, path: &str, recursive: bool) -> Result<(), String> {
    done(
        conn,
        FsOp::Delete {
            path: path.to_string(),
            recursive,
        },
    )
    .await
}

// The IPC surface: one command per operation, taking the connection the frontend already holds.

#[tauri::command]
#[specta::specta]
pub async fn list_directories(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<Vec<String>, String> {
    directories(&connect(&app_state, connection, path.clone()).await?, &path).await
}

/// Where the directory picker starts on a connection: its user's home folder.
#[tauri::command]
#[specta::specta]
pub async fn get_connection_home(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<String, String> {
    home(&connect(&app_state, connection, String::new()).await?).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_contents(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
    include_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    contents(
        &connect(&app_state, connection, path.clone()).await?,
        &path,
        include_hidden,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_workspace_files(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
    include_hidden: bool,
) -> Result<Vec<String>, String> {
    workspace_files(
        &connect(&app_state, connection, path.clone()).await?,
        &path,
        include_hidden,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_artifact_files(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
    since_ms: f64,
) -> Result<Vec<ArtifactFile>, String> {
    artifact_files(
        &connect(&app_state, connection, path.clone()).await?,
        &path,
        since_ms,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn read_file(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<String, String> {
    read_text(&connect(&app_state, connection, path.clone()).await?, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_file_binary(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<String, String> {
    read_binary(&connect(&app_state, connection, path.clone()).await?, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn write_file(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
    contents: String,
) -> Result<(), String> {
    write_text(
        &connect(&app_state, connection, path.clone()).await?,
        &path,
        &contents,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_file_at(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<(), String> {
    create_file(&connect(&app_state, connection, path.clone()).await?, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_directory_at(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<(), String> {
    create_directory(&connect(&app_state, connection, path.clone()).await?, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_file(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    from: String,
    to: String,
) -> Result<(), String> {
    rename_path(
        &connect(&app_state, connection, from.clone()).await?,
        &from,
        &to,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_file(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    delete_path(
        &connect(&app_state, connection, path.clone()).await?,
        &path,
        recursive,
    )
    .await
}

/// Create the destination directory and copy into it in one command, so a copy costs one round
/// trip rather than two.
fn copy_script(dir: &str, source: &str, dest: &str) -> String {
    format!(
        "mkdir -p {} && cp {} {}",
        shell_quote(dir),
        shell_quote(source),
        shell_quote(dest)
    )
}

/// Copy a host file to `dest` on the machine `conn` points at, creating `dir` first. The one
/// transfer path for prompt attachments and task attachments alike.
pub(crate) async fn copy_to_machine(
    app_state: &AppState,
    conn: &GitConnection,
    source: &std::path::Path,
    dir: &str,
    dest: &str,
) -> Result<(), String> {
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or(dest);
    match conn {
        GitConnection::Local { .. } => {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|e| format!("Failed to create {dir}: {e}"))?;
            tokio::fs::copy(source, dest)
                .await
                .map_err(|e| format!("Failed to copy '{name}' to {dest}: {e}"))?;
        }
        GitConnection::Remote { ssh, .. } => {
            crate::connectivity::files::create_dir_all(conn, dir).await?;
            crate::connectivity::ssh::sftp::upload_file(
                ssh,
                source,
                dest,
                &format!("attach-{dest}"),
                &app_state.app_handle,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        // The host's drives are already mounted inside the distro, so this copies without the
        // bytes ever leaving the machine.
        GitConnection::Wsl { distro, .. } => {
            let source = source.to_str().ok_or("Source path is not valid UTF-8")?;
            let source = crate::connectivity::wsl::to_wsl_path(distro, source).await?;
            let output = crate::connectivity::exec_channel::run_on(
                conn,
                None,
                "sh",
                &["-c", &copy_script(dir, &source, dest)],
            )
            .await?;
            if !output.success() {
                return Err(format!(
                    "Failed to copy '{name}' into {distro}: {}",
                    output.stderr_string()
                ));
            }
        }
        GitConnection::Docker { container_name, .. } => {
            crate::connectivity::files::create_dir_all(conn, dir).await?;
            let cli = crate::connectivity::docker::ContainerCli::detect()?;
            crate::connectivity::docker::copy_into(&cli, container_name, source, dest).await?;
        }
    }
    Ok(())
}
