use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

fn project_path(state: &AppState, project_id: i32) -> Result<String, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("DB lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| format!("Project {} not found", project_id))
}

async fn get_acp_session_id(state: &AppState, log_id: i32) -> Result<String, String> {
    let sessions = state.acp.sessions.lock().await;
    let session = sessions
        .get(&log_id)
        .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
    let id = session
        .acp_session_id
        .lock()
        .map_err(|_| "acp_session_id lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Session not yet initialized (no acp_session_id)".to_string());
    id
}

fn canvas_dir(project_path: &str, acp_session_id: &str) -> PathBuf {
    PathBuf::from(project_path)
        .join(".maestro")
        .join("canvases")
        .join(acp_session_id)
}

/// Write one surface as a self-contained `.html` file.
///
/// `html` is the agent's own document plus the `<title>` and `<meta>` tags the frontend folds in;
/// Maestro's injected head is deliberately absent, so the file opens in any browser.
#[tauri::command]
#[specta::specta]
pub async fn save_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
    surface_id: String,
    html: String,
) -> Result<(), String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let dir = canvas_dir(&path, &acp_session_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create canvas directory: {}", e))?;
    let file_path = dir.join(format!("{}.html", surface_id));
    tokio::fs::write(&file_path, html)
        .await
        .map_err(|e| format!("Failed to write canvas file: {}", e))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_canvas_surface(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
    surface_id: String,
) -> Result<(), String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let file_path = canvas_dir(&path, &acp_session_id).join(format!("{}.html", surface_id));
    match tokio::fs::remove_file(&file_path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete canvas file: {}", e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn load_saved_canvases(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    log_id: i32,
) -> Result<Vec<String>, String> {
    let path = project_path(&app_state, project_id)?;
    let acp_session_id = get_acp_session_id(&app_state, log_id).await?;
    let dir = canvas_dir(&path, &acp_session_id);
    let mut read_dir = match tokio::fs::read_dir(&dir).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Failed to read canvas directory: {}", e)),
    };
    let mut surfaces = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read directory entry: {}", e))?
    {
        let entry_path = entry.path();
        // Canvases saved by an older build are `.json` in the same directory. They are left where
        // they are rather than migrated: nothing here can turn a component tree into a document.
        if entry_path.extension().and_then(|e| e.to_str()) != Some("html") {
            continue;
        }
        if let Ok(contents) = tokio::fs::read_to_string(&entry_path).await {
            surfaces.push(contents);
        }
    }
    Ok(surfaces)
}

/// Note something a canvas frame could not load or run, for the agent's next canvas tool call.
///
/// Capped per surface: a document whose script throws on every animation frame would otherwise
/// grow this without bound, and the oldest few failures are the ones that explain the rest.
#[tauri::command]
#[specta::specta]
pub async fn canvas_report_error(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    surface_id: String,
    message: String,
) -> Result<(), String> {
    const MAX_PER_SURFACE: usize = 10;
    let mut errors = app_state.acp.canvas_errors.lock().await;
    let entry = errors.entry((log_id, surface_id)).or_default();
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
