//! File browsing over any connection.
//!
//! There used to be a copy of each of these operations per connection type — four `read_file`s,
//! four workspace walks — and they had drifted: containers never checked a file's size, SSH never
//! capped the workspace listing, and two of them interpolated the path into a shell command
//! unquoted. There is one implementation each now, with a single local branch where the host has
//! no POSIX shell to run the remote form.

use std::sync::Arc;
use tauri::State;

use crate::acp::ConnectionKey;
use crate::connectivity::exec_channel::run_on;
use crate::connectivity::filesystem_handlers::{self, FileEntry};
use crate::core::AppState;
use crate::git::remote::shell_quote;
use crate::models::GitConnection;

/// Text files above this are refused rather than streamed into the UI.
const TEXT_LIMIT: usize = 512 * 1024;
/// Binary files above this are refused: the base64 of one already costs a third more again.
const BINARY_LIMIT: usize = 10 * 1024 * 1024;
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
    run_on(conn, None, "test", &["-e", path]).await.map(|out| out.success()).unwrap_or(false)
}

/// Whether `path` is an existing directory on the connection's host, distinguishing "no" from
/// "could not ask" — callers that treat an unreachable host as an empty one delete real data.
pub async fn try_dir_exists(conn: &GitConnection, path: &str) -> Result<bool, String> {
    if is_local(conn) {
        return Ok(std::path::Path::new(path).is_dir());
    }
    let output = run_on(conn, None, "test", &["-d", path]).await?;
    match output.exit_code {
        0 => Ok(true),
        // `test` reports "no" with exactly 1. Any other code came from the transport — an
        // unregistered distro exits 1 too on some builds but a stopped container exits 125/126,
        // and `docker exec` on a dead daemon exits 1 from the CLI itself. Treat only a clean 1
        // as an answer, because the caller deletes rows on the strength of it.
        1 if !output.stderr.is_empty() => {
            Err(format!("could not check {path}: {}", output.stderr_string()))
        }
        1 => Ok(false),
        code => Err(format!("could not check {path}: exit {code} {}", output.stderr_string())),
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
        Err(format!("Failed to create {path}: {}", output.stderr_string()))
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

/// Directories then files under `path`, each sorted, hidden entries excluded.
pub async fn contents(conn: &GitConnection, path: &str) -> Result<Vec<FileEntry>, String> {
    if is_local(conn) {
        return filesystem_handlers::local_contents(path.to_string()).await;
    }
    let (dirs, files) = parse_listing(&listing(conn, path).await?, false);
    let mut result: Vec<FileEntry> =
        dirs.into_iter().map(|name| FileEntry { name, is_dir: true }).collect();
    result.extend(files.into_iter().map(|name| FileEntry { name, is_dir: false }));
    Ok(result)
}

/// Every non-hidden file under `path`, as paths relative to it.
pub async fn workspace_files(conn: &GitConnection, path: &str) -> Result<Vec<String>, String> {
    if is_local(conn) {
        return filesystem_handlers::local_workspace_files(path.to_string()).await;
    }
    let listing = script(
        conn,
        &format!(
            "cd {} && find . -maxdepth 8 -type f -not -path '*/.*' -not -path '*/node_modules/*' \
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
) -> Result<Vec<FileEntry>, String> {
    contents(&connect(&app_state, connection, path.clone()).await?, &path).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_workspace_files(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    path: String,
) -> Result<Vec<String>, String> {
    workspace_files(&connect(&app_state, connection, path.clone()).await?, &path).await
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

#[cfg(test)]
mod tests {
    use super::parse_listing;

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
}
