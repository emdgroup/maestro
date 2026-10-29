//! File browsing over any connection.
//!
//! There used to be a copy of each of these operations per connection type — four `read_file`s,
//! four workspace walks — and they had drifted: containers never checked a file's size, SSH never
//! capped the workspace listing, and two of them interpolated the path into a shell command
//! unquoted. There is one implementation each now, with a single local branch where the host has
//! no POSIX shell to run the remote form.

use serde::Serialize;
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::ConnectionKey;
use crate::connectivity::docker_handlers::run_blocking;
use crate::connectivity::exec_channel::{run_on, run_with_stdin, ExecTarget};
use crate::connectivity::filesystem_handlers::{self, FileEntry};
use crate::core::AppState;
use crate::git::remote::shell_quote;
use crate::models::GitConnection;

/// Text files above this are refused rather than streamed into the UI.
pub(crate) const TEXT_LIMIT: usize = 512 * 1024;
/// Binary files above this are refused: the base64 of one already costs a third more again.
pub(crate) const BINARY_LIMIT: usize = 10 * 1024 * 1024;
/// A workspace listing is for a file picker, not an inventory.
const MAX_WORKSPACE_FILES: usize = 2000;

async fn connect(
    app_state: &AppState,
    connection: ConnectionKey,
    path: String,
) -> Result<GitConnection, String> {
    crate::core::git_connection_for(app_state, path, connection).await
}

fn is_local(conn: &GitConnection) -> bool {
    matches!(conn, GitConnection::Local { .. })
}

/// Run a shell script on the connection's host and return its stdout, failing with stderr.
async fn script(conn: &GitConnection, script: &str, what: &str) -> Result<Vec<u8>, String> {
    let output = run_on(conn, None, "sh", &["-c", script]).await?;
    if !output.success() {
        return Err(format!("Failed to {}: {}", what, output.stderr_string()));
    }
    Ok(output.stdout)
}

/// The single character `ls -F` appends to classify an entry. `/` is handled separately because
/// it is the only one that changes which list an entry lands in.
const LS_MARKERS: [char; 4] = ['*', '@', '=', '|'];

/// Directory listing, tolerant of the partial results `ls` produces.
///
/// `-L` follows symlinks so a link to a directory is classified as one, matching what the local
/// branch reports through `metadata()`. Passed as argv rather than through `sh -c`, so a path
/// needs no quoting at all.
async fn listing(conn: &GitConnection, path: &str) -> Result<String, String> {
    let output = run_on(conn, None, "ls", &["-1aFL", path]).await?;
    // `ls` exits non-zero when it could not stat a single entry, having printed all the others.
    // Only an empty result is a real failure.
    if !output.success() && output.stdout.is_empty() {
        return Err(format!("Failed to list {path}: {}", output.stderr_string()));
    }
    Ok(output.stdout_string())
}

/// Split `ls -1aF` output into directories and files. The trailing markers are what let one
/// listing answer both without a stat per entry.
fn parse_listing(text: &str, include_hidden: bool) -> (Vec<String>, Vec<String>) {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line == "./" || line == "../" || line == "." || line == ".." {
            continue;
        }
        if !include_hidden && line.starts_with('.') {
            continue;
        }
        if let Some(name) = line.strip_suffix('/') {
            dirs.push(name.to_string());
        } else {
            // Exactly one marker, never a run of them: a file legitimately named `report|` would
            // otherwise come back as `report`.
            let name = match line.chars().next_back() {
                Some(last) if LS_MARKERS.contains(&last) => &line[..line.len() - last.len_utf8()],
                _ => line,
            };
            files.push(name.to_string());
        }
    }
    dirs.sort();
    files.sort();
    (dirs, files)
}

/// Whether `path` exists at all on the connection's host, of any kind.
pub async fn exists(conn: &GitConnection, path: &str) -> bool {
    if is_local(conn) {
        return std::path::Path::new(path).exists();
    }
    run_on(conn, None, "test", &["-e", path])
        .await
        .map(|out| out.success())
        .unwrap_or(false)
}

/// Whether `path` is an existing directory on the connection's host, distinguishing "no" from
/// "could not ask" — callers that treat an unreachable host as an empty one delete real data.
pub async fn try_dir_exists(conn: &GitConnection, path: &str) -> Result<bool, String> {
    if is_local(conn) {
        return Ok(std::path::Path::new(path).is_dir());
    }
    remote_test(conn, "-d", path).await
}

/// [`exists`], distinguishing "no" from "could not ask" as [`try_dir_exists`] does.
pub async fn try_exists(conn: &GitConnection, path: &str) -> Result<bool, String> {
    if is_local(conn) {
        return Ok(std::path::Path::new(path).exists());
    }
    remote_test(conn, "-e", path).await
}

async fn remote_test(conn: &GitConnection, flag: &str, path: &str) -> Result<bool, String> {
    let output = run_on(conn, None, "test", &[flag, path]).await?;
    match output.exit_code {
        0 => Ok(true),
        // `test` reports "no" with exactly 1. Any other code came from the transport — an
        // unregistered distro exits 1 too on some builds but a stopped container exits 125/126,
        // and `docker exec` on a dead daemon exits 1 from the CLI itself. Treat only a clean 1
        // as an answer, because the caller deletes rows on the strength of it.
        1 if !output.stderr.is_empty() => Err(format!(
            "could not check {path}: {}",
            output.stderr_string()
        )),
        1 => Ok(false),
        code => Err(format!(
            "could not check {path}: exit {code} {}",
            output.stderr_string()
        )),
    }
}

/// Whether `path` is an existing directory on the connection's host.
pub async fn dir_exists(conn: &GitConnection, path: &str) -> bool {
    try_dir_exists(conn, path).await.unwrap_or(false)
}

/// Create `path` and any missing parents on the connection's host.
pub async fn create_dir_all(conn: &GitConnection, path: &str) -> Result<(), String> {
    if is_local(conn) {
        return std::fs::create_dir_all(path).map_err(|e| format!("Failed to create {path}: {e}"));
    }
    let output = run_on(conn, None, "mkdir", &["-p", path]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to create {path}: {}",
            output.stderr_string()
        ))
    }
}

/// Subdirectories of `path`, hidden ones included — this feeds the directory picker, where a
/// project may well live under a dotted folder.
pub async fn directories(conn: &GitConnection, path: &str) -> Result<Vec<String>, String> {
    if is_local(conn) {
        return filesystem_handlers::local_directories(path.to_string()).await;
    }
    let (dirs, _files) = parse_listing(&listing(conn, path).await?, true);
    Ok(dirs)
}

/// Directories then files under `path`, each sorted.
pub async fn contents(
    conn: &GitConnection,
    path: &str,
    include_hidden: bool,
) -> Result<Vec<FileEntry>, String> {
    if is_local(conn) {
        return filesystem_handlers::local_contents(path.to_string(), include_hidden).await;
    }
    let (dirs, files) = parse_listing(&listing(conn, path).await?, include_hidden);
    let mut result: Vec<FileEntry> = dirs
        .into_iter()
        .map(|name| FileEntry { name, is_dir: true })
        .collect();
    result.extend(files.into_iter().map(|name| FileEntry {
        name,
        is_dir: false,
    }));
    Ok(result)
}

/// Every file under `path`, as paths relative to it.
pub async fn workspace_files(
    conn: &GitConnection,
    path: &str,
    include_hidden: bool,
) -> Result<Vec<String>, String> {
    if is_local(conn) {
        return filesystem_handlers::local_workspace_files(path.to_string(), include_hidden).await;
    }
    // `.git` stays out even with hidden entries asked for: its object store alone would exhaust
    // MAX_WORKSPACE_FILES and leave no room for the files the picker exists to find.
    let hidden_pruning = if include_hidden {
        "-not -path '*/.git/*'"
    } else {
        "-not -path '*/.*'"
    };
    let listing = script(
        conn,
        &format!(
            "cd {} && find . -maxdepth 8 -type f {hidden_pruning} -not -path '*/node_modules/*' \
             -not -path '*/target/*' -not -path '*/dist/*' 2>/dev/null \
             | sed 's|^\\./||' | sort | head -{MAX_WORKSPACE_FILES}",
            shell_quote(path)
        ),
        "list workspace files",
    )
    .await?;
    Ok(String::from_utf8_lossy(&listing)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
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
    let root = root.trim_end_matches(['/', '\\']).to_string();
    let mut files = if is_local(conn) {
        run_blocking(move || Ok(local_artifact_files(&root, since_ms))).await?
    } else {
        remote_artifact_files(conn, &root, since_ms).await?
    };
    files.sort_by(|a, b| {
        a.modified_ms
            .total_cmp(&b.modified_ms)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(files)
}

fn local_artifact_files(root: &str, since_ms: f64) -> Vec<ArtifactFile> {
    let mut files = Vec::new();
    let mut pending: Vec<(std::path::PathBuf, String)> = ARTIFACT_DIRS
        .iter()
        .map(|dir| (std::path::Path::new(root).join(dir), dir.to_string()))
        .collect();
    while let Some((dir, relative)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            // `DirEntry::metadata` does not follow symlinks, so a link cannot loop the walk.
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let relative = format!("{relative}/{name}");
            if meta.is_dir() {
                pending.push((entry.path(), relative));
                continue;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_millis() as f64);
            if let Some(modified_ms) = modified_ms.filter(|ms| *ms >= since_ms) {
                files.push(ArtifactFile {
                    path: format!("{root}/{relative}"),
                    modified_ms,
                });
                if files.len() >= MAX_WORKSPACE_FILES {
                    return files;
                }
            }
        }
    }
    files
}

async fn remote_artifact_files(
    conn: &GitConnection,
    root: &str,
    since_ms: f64,
) -> Result<Vec<ArtifactFile>, String> {
    // `-mmin` reads the age on the host's own clock, so it never has to agree with this one. It
    // rounds up to the minute, so a file written just before the session started can slip in.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|now| now.as_millis() as f64)
        .unwrap_or(since_ms);
    let minutes = ((now_ms - since_ms) / 60_000.0).ceil().max(1.0) as u64;
    let dirs: Vec<String> = ARTIFACT_DIRS.iter().map(|dir| shell_quote(dir)).collect();
    // ponytail: `stat -c` is GNU and busybox only, so a macOS host lists no artifacts; switch to
    // `stat -f` there if one ever shows up.
    let listing = script(
        conn,
        &format!(
            "cd {} && find {} -type f -mmin -{minutes} -exec stat -c '%Y %n' {{}} + 2>/dev/null \
             | head -{MAX_WORKSPACE_FILES}",
            shell_quote(root),
            dirs.join(" ")
        ),
        "list artifacts",
    )
    .await?;
    Ok(parse_artifact_listing(
        root,
        &String::from_utf8_lossy(&listing),
    ))
}

/// Parse `stat -c '%Y %n'` lines, seconds then the path relative to `root`.
fn parse_artifact_listing(root: &str, text: &str) -> Vec<ArtifactFile> {
    text.lines()
        .filter_map(|line| {
            let (secs, relative) = line.trim().split_once(' ')?;
            Some(ArtifactFile {
                path: format!("{root}/{relative}"),
                modified_ms: secs.parse::<f64>().ok()? * 1000.0,
            })
        })
        .collect()
}

/// A file's text content. Binary files and anything over [`TEXT_LIMIT`] are refused.
pub async fn read_text(conn: &GitConnection, path: &str) -> Result<String, String> {
    if is_local(conn) {
        return filesystem_handlers::read_local_file(path.to_string()).await;
    }
    // One byte past the limit, so an oversized file is distinguishable from one that just fits.
    let bytes = script(
        conn,
        &format!("head -c {} {}", TEXT_LIMIT + 1, shell_quote(path)),
        "read file",
    )
    .await?;
    if bytes.contains(&0u8) {
        return Err("Binary file".to_string());
    }
    if bytes.len() > TEXT_LIMIT {
        return Err("File too large".to_string());
    }
    String::from_utf8(bytes).map_err(|e| format!("Failed to read file: {}", e))
}

/// A file's raw content, base64-encoded. Anything over [`BINARY_LIMIT`] is refused.
pub async fn read_binary(conn: &GitConnection, path: &str) -> Result<String, String> {
    if is_local(conn) {
        return filesystem_handlers::read_local_file_binary(path.to_string()).await;
    }
    // Sized first: encoding a huge file only to reject it would send it over the wire anyway.
    // `base64` is piped through `tr` rather than given `-w0`, which BusyBox's applet — what an
    // Alpine container has — does not accept.
    let quoted = shell_quote(path);
    let bytes = script(
        conn,
        &format!(
            "s=$(wc -c < {quoted} 2>/dev/null); \
             if [ \"${{s:-0}}\" -gt {BINARY_LIMIT} ]; then echo 'ERR:too_large'; \
             else base64 < {quoted} | tr -d '\\n'; fi"
        ),
        "read file",
    )
    .await?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim();
    if text == "ERR:too_large" {
        return Err("File too large".to_string());
    }
    Ok(text.to_string())
}

/// A temporary name in the destination's own directory, unique without any shell help.
///
/// The counter is here for the same reason [`crate::core::project_storage::atomic_write_script`]
/// has one: two concurrent writes with a fixed name race, the first `mv` consumes the temporary
/// and the second fails having lost its content.
fn temp_sibling(path: &str) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{path}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// The script the remote write runs, with the content arriving on stdin rather than in it.
///
/// Kept to `>`, `&&` and `mv` for the same reason
/// [`crate::core::project_storage::atomic_write_script`] is: SSH runs this through the user's
/// *login* shell, not `sh -c`, so anything a non-POSIX login shell might not parse is a host we
/// silently cannot write to. Nothing cleans up the temporary here — a `||` tail would replace the
/// failure's exit code with `rm`'s success and the caller would report the write as having worked.
fn remote_write_script(path: &str, temp_path: &str) -> String {
    format!(
        "base64 -d > {} && mv -f {} {}",
        shell_quote(temp_path),
        shell_quote(temp_path),
        shell_quote(path),
    )
}

/// Replace a file's text content, without exposing a half-written file to the agent reading it.
///
/// The remote form pipes base64 over stdin rather than interpolating the content into the command
/// the way [`crate::core::project_storage::atomic_write_script`] does. That helper writes
/// `state.json`, a couple of hundred bytes; a source file put on the command line blows past the
/// argv limit on the WSL and container paths, where the script becomes a real process argument
/// list. Base64 also removes the question of quoting arbitrary file content entirely.
pub async fn write_text(conn: &GitConnection, path: &str, contents: &str) -> Result<(), String> {
    if contents.len() > TEXT_LIMIT {
        return Err("File too large".to_string());
    }

    if is_local(conn) {
        return crate::core::project_storage::atomic_write(
            std::path::Path::new(path),
            contents.as_bytes(),
        )
        .map_err(|e| format!("Failed to write {path}: {e}"));
    }

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let encoded = STANDARD.encode(contents.as_bytes());
    let temp_path = temp_sibling(path);
    let command = remote_write_script(path, &temp_path);

    let output = run_with_stdin(
        &ExecTarget::of(conn),
        None,
        "sh",
        &["-c", &command],
        Some(encoded.into_bytes()),
    )
    .await?;

    if output.success() {
        return Ok(());
    }

    // Cleaning up in the script would mask the failure in its exit code, so the temporary is
    // removed separately and only its own failure is swallowed.
    if let Err(e) = run_on(conn, None, "rm", &["-f", &temp_path]).await {
        log::warn!("could not remove {temp_path} after a failed write: {e}");
    }
    Err(format!(
        "Failed to write {path}: {}",
        output.stderr_string()
    ))
}

/// Create an empty file, refusing to truncate one that is already there.
pub async fn create_file(conn: &GitConnection, path: &str) -> Result<(), String> {
    if is_local(conn) {
        return std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(|_| ())
            .map_err(|e| format!("Failed to create {path}: {e}"));
    }
    // `touch` is happy to reopen an existing file, so the check is what makes this a create.
    // It is advisory — nothing holds a lock between here and the command below.
    if exists(conn, path).await {
        return Err(format!("{path} already exists"));
    }
    let output = run_on(conn, None, "touch", &[path]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to create {path}: {}",
            output.stderr_string()
        ))
    }
}

/// Create a single directory. Unlike [`create_dir_all`] an existing path is an error, because the
/// caller is a user typing a new name rather than code ensuring a layout.
pub async fn create_directory(conn: &GitConnection, path: &str) -> Result<(), String> {
    if is_local(conn) {
        return std::fs::create_dir(path).map_err(|e| format!("Failed to create {path}: {e}"));
    }
    // Plain `mkdir` fails on an existing path by itself, so no separate check is needed here.
    let output = run_on(conn, None, "mkdir", &[path]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to create {path}: {}",
            output.stderr_string()
        ))
    }
}

/// Move a file or directory, refusing to replace anything already at the destination.
pub async fn rename_path(conn: &GitConnection, from: &str, to: &str) -> Result<(), String> {
    // `fs::rename` replaces the destination on Unix and `mv` replaces it everywhere, so the check
    // is what stops a rename from silently destroying a sibling. Advisory, as in `create_file`.
    if exists(conn, to).await {
        return Err(format!("{to} already exists"));
    }
    if is_local(conn) {
        return std::fs::rename(from, to).map_err(|e| format!("Failed to rename {from}: {e}"));
    }
    let output = run_on(conn, None, "mv", &[from, to]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to rename {from}: {}",
            output.stderr_string()
        ))
    }
}

/// Delete a file, or a directory and everything under it when `recursive` is set.
pub async fn delete_path(conn: &GitConnection, path: &str, recursive: bool) -> Result<(), String> {
    if is_local(conn) {
        let result = if recursive {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        return result.map_err(|e| format!("Failed to delete {path}: {e}"));
    }
    let flag = if recursive { "-rf" } else { "-f" };
    let output = run_on(conn, None, "rm", &[flag, path]).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to delete {path}: {}",
            output.stderr_string()
        ))
    }
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

#[cfg(test)]
mod tests {
    use super::{
        local_artifact_files, parse_artifact_listing, parse_listing, remote_write_script,
        temp_sibling, ArtifactFile,
    };

    /// Only the artifact folders are walked, nested folders included, and only files changed since
    /// the session started count.
    #[test]
    fn artifacts_come_from_the_artifact_folders_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        for file in [
            ".planning/plan.md",
            ".maestro/artifacts/out/report.html",
            ".maestro/state.json",
            "src/loop-draft.ts",
        ] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }

        let mut paths: Vec<String> = local_artifact_files(&root, 0.0)
            .into_iter()
            .map(|file| file.path)
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                format!("{root}/.maestro/artifacts/out/report.html"),
                format!("{root}/.planning/plan.md"),
            ]
        );
        assert!(local_artifact_files(&root, f64::MAX).is_empty());
    }

    #[test]
    fn artifact_listing_keeps_spaces_in_names() {
        assert_eq!(
            parse_artifact_listing("/w", "1700000000 .planning/my plan.md\n\nnot-a-line\n"),
            vec![ArtifactFile {
                path: "/w/.planning/my plan.md".to_string(),
                modified_ms: 1_700_000_000_000.0,
            }]
        );
    }

    /// `ls -1aF` is the whole reason one listing can answer both "which are directories" and
    /// "what is in here": the markers it appends are the only type information in the output, and
    /// they must not survive into the names shown to the user.
    #[test]
    fn listing_splits_on_the_ls_markers_and_strips_them() {
        let output = "./\n../\nsrc/\n.git/\nREADME.md\nbuild.sh*\nlink@\n";

        let (dirs, files) = parse_listing(output, true);
        assert_eq!(dirs, vec![".git", "src"]);
        assert_eq!(files, vec!["README.md", "build.sh", "link"]);

        let (dirs, files) = parse_listing(output, false);
        assert_eq!(dirs, vec!["src"]);
        assert_eq!(files, vec!["README.md", "build.sh", "link"]);
    }

    /// `ls -F` appends exactly one classifier, so only one may come off. Stripping the whole run
    /// silently renamed any file whose own name ended in one of those characters.
    #[test]
    fn only_one_marker_is_stripped_from_a_name() {
        let (_dirs, files) = parse_listing("report|*\nnotes=\nplain\n", true);
        assert_eq!(files, vec!["notes", "plain", "report|"]);
    }

    /// The file's bytes must never appear in the command. They arrive on stdin precisely so that a
    /// 200 KB source file does not have to fit in an argument list, which is where the WSL and
    /// container paths would refuse it.
    #[test]
    fn the_remote_write_carries_no_content_and_quotes_both_paths() {
        let script = remote_write_script("/home/u/it's here.ts", "/home/u/it's here.ts.7.0.tmp");

        // Spelled out in full because the apostrophe and the space are the whole point: both paths
        // stay single arguments, and `shell_quote` closes and reopens its quote around the `'`.
        assert_eq!(
            script,
            r#"base64 -d > '/home/u/it'\''s here.ts.7.0.tmp' && mv -f '/home/u/it'\''s here.ts.7.0.tmp' '/home/u/it'\''s here.ts'"#
        );
    }

    /// The temporary has to sit in the destination's own directory, or the `mv` stops being a
    /// metadata rename and becomes a cross-volume copy that a reader can catch half-written.
    #[test]
    fn the_temporary_is_a_sibling_of_its_destination() {
        let temp = temp_sibling("/srv/app/config.json");
        assert!(
            temp.starts_with("/srv/app/config.json."),
            "{temp} left its directory"
        );
        assert!(temp.ends_with(".tmp"), "{temp} is not marked temporary");
        assert_ne!(
            temp,
            temp_sibling("/srv/app/config.json"),
            "two writes must not collide"
        );
    }
}
