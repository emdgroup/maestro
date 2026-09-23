use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::connectivity::files;
use crate::core::AppState;
use crate::models::GitConnection;

/// Where a session keeps its canvases, and the connection to reach them over.
///
/// Both come from the session rather than from the project row: an SSH, WSL or container session's
/// files live on *that* machine, and its working directory is the worktree the agent was started
/// in — which is also the only place the agent can read a canvas back from.
async fn canvas_target(
    state: &AppState,
    session_id: &str,
) -> Result<(GitConnection, String, String), String> {
    let (cwd, connection_key, acp_session_id) = {
        let sessions = state.acp.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No ACP session for session_id {}", session_id))?;
        let acp_session_id = session
            .acp_session_id
            .lock()
            .map_err(|_| "acp_session_id lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "Session not yet initialized (no acp_session_id)".to_string())?;
        (session.cwd.clone(), session.connection_key, acp_session_id)
    };
    let conn = crate::core::git_connection_for(state, cwd.clone(), connection_key).await?;
    let dir = format!("{cwd}/.maestro/canvases/{acp_session_id}");
    Ok((conn, cwd, dir))
}

/// A surface id and an imported file name both reach here from outside, and both are pasted into a
/// path. Anything that could climb out of the session's own directory is refused.
fn plain_file_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("{name} is not a usable file name"));
    }
    Ok(name)
}

/// Write one surface as a self-contained `.html` file.
///
/// `html` is the agent's own document plus the `<title>` and `<meta>` tags the frontend folds in;
/// Maestro's injected head is deliberately absent, so the file opens in any browser.
#[tauri::command]
#[specta::specta]
pub async fn save_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    surface_id: String,
    html: String,
) -> Result<(), String> {
    let surface_id = plain_file_name(&surface_id)?;
    let (conn, _cwd, dir) = canvas_target(&app_state, session_id).await?;
    files::create_dir_all(&conn, &dir).await?;
    files::write_text(&conn, &format!("{dir}/{surface_id}.html"), &html).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    surface_id: String,
) -> Result<(), String> {
    let surface_id = plain_file_name(&surface_id)?;
    let (conn, _cwd, dir) = canvas_target(&app_state, session_id).await?;
    let file_path = format!("{dir}/{surface_id}.html");
    if !files::exists(&conn, &file_path).await {
        return Ok(());
    }
    files::delete_path(&conn, &file_path, false).await
}

#[tauri::command]
#[specta::specta]
pub async fn load_saved_canvases(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let (conn, _cwd, dir) = canvas_target(&app_state, session_id).await?;
    if !files::exists(&conn, &dir).await {
        return Ok(vec![]);
    }
    let mut surfaces = Vec::new();
    for entry in files::contents(&conn, &dir, false).await? {
        // Canvases saved by an older build are `.json` in the same directory. They are left where
        // they are rather than migrated: nothing here can turn a component tree into a document.
        if entry.is_dir || !entry.name.ends_with(".html") {
            continue;
        }
        match files::read_text(&conn, &format!("{dir}/{}", entry.name)).await {
            Ok(contents) => surfaces.push(contents),
            Err(e) => log::warn!("[canvas] could not read {}/{}: {e}", dir, entry.name),
        }
    }
    Ok(surfaces)
}

/// Put a document the user imported where the agent can read it, and say where that is.
///
/// The path is built here rather than in the frontend for the same reason the canvas directory is:
/// for a remote session it names a directory on the agent's machine, not on this one.
#[tauri::command]
#[specta::specta]
pub async fn save_canvas_import(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    file_name: String,
    html: String,
) -> Result<String, String> {
    let file_name = plain_file_name(&file_name)?;
    let (conn, cwd, _dir) = canvas_target(&app_state, session_id).await?;
    let dir = format!("{cwd}/.maestro/imports");
    files::create_dir_all(&conn, &dir).await?;
    let path = format!("{dir}/{file_name}");
    files::write_text(&conn, &path, &html).await?;
    Ok(path)
}

/// Note something a canvas frame could not load or run, for the agent's next canvas tool call.
///
/// Capped per surface: a document whose script throws on every animation frame would otherwise
/// grow this without bound, and the oldest few failures are the ones that explain the rest.
#[tauri::command]
#[specta::specta]
pub async fn canvas_report_error(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    surface_id: String,
    message: String,
) -> Result<(), String> {
    const MAX_PER_SURFACE: usize = 10;
    let mut errors = app_state.acp.canvas_errors.lock().await;
    let entry = errors
        .entry((session_id.to_string(), surface_id))
        .or_default();
    if entry.len() < MAX_PER_SURFACE && !entry.contains(&message) {
        entry.push(message);
    }
    Ok(())
}

/// One request a canvas asked the host to make on its behalf.
///
/// The surface's frame has an opaque origin, so an endpoint without `Access-Control-Allow-Origin`
/// cannot be read from inside it at all. This is the way round that, and it is deliberately narrow:
/// the *host* machine performs the request, which for an SSH, WSL or container session is not the
/// machine the agent is on. The declared `sources` allow-list is enforced by the caller, which is
/// the only thing holding the surface it belongs to; what is enforced here is everything that does
/// not depend on that list.
#[derive(serde::Serialize, specta::Type)]
pub struct CanvasFetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Enough for a JSON API answer; a canvas that needs more than this wants a file, not a fetch.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[tauri::command]
#[specta::specta]
pub async fn canvas_fetch(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<CanvasFetchResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Not a URL: {}", e))?;
    let host = parsed.host_str().unwrap_or_default();
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => {}
        "http" if local => {}
        scheme => {
            return Err(format!(
                "{scheme}: is not allowed from a canvas — use https, or http on localhost"
            ))
        }
    }

    let method = method.unwrap_or_else(|| "GET".to_string());
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Not an HTTP method: {}", method))?;

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        // A redirect off the declared origin would reach somewhere the user was never shown.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Could not build the HTTP client: {}", e))?;

    let mut request = client.request(method, parsed);
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status().as_u16();
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read the response: {}", e))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!(
            "Response is {} bytes, over the {MAX_BODY_BYTES} byte limit for a canvas fetch",
            bytes.len()
        ));
    }
    Ok(CanvasFetchResponse {
        status,
        headers: response_headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}
