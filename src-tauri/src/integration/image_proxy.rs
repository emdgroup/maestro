use std::sync::Arc;

use base64::Engine as _;
use tauri::State;

use crate::core::AppState;
use crate::models::project::ProjectConfig;

const MAX_PROXY_IMAGE_SIZE: u64 = 10 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub async fn proxy_image(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    image_url: String,
) -> Result<String, String> {
    let bytes = if image_url.starts_with("http://") || image_url.starts_with("https://") {
        fetch_image_with_auth(&app_state, project_id, &image_url).await?
    } else if let Some(attachment_id) = image_url.strip_prefix("attachment:") {
        fetch_jira_attachment(&app_state, project_id, attachment_id).await?
    } else {
        read_local_or_remote_image(&app_state, project_id, &image_url).await?
    };

    if bytes.len() as u64 > MAX_PROXY_IMAGE_SIZE {
        return Err(format!(
            "Image too large ({:.1} MB, max 10 MB)",
            bytes.len() as f64 / 1_048_576.0
        ));
    }

    let mime = mime_from_bytes_or_url(&bytes, &image_url);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

async fn fetch_image_with_auth(
    app_state: &AppState,
    project_id: i32,
    url: &str,
) -> Result<Vec<u8>, String> {
    let client = crate::integration::build_http_client()?;

    let (_project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    let config: ProjectConfig =
        crate::core::read_maestro_json(&git_conn, crate::project::settings::SETTINGS_FILE).await;
    let ticketing = config.issue_tracking.as_ref();

    let mut request = client.get(url);

    if let Some(tc) = ticketing {
        if let Ok(creds) = super::issue_tracking_handlers::get_integration_creds(&tc.provider, app_state) {
            request = match tc.provider.as_str() {
                "github" => request.header("Authorization", format!("Bearer {}", creds.token)),
                "gitlab" => request.header("PRIVATE-TOKEN", &creds.token),
                "jira_cloud" => {
                    let email = creds.email.as_deref().unwrap_or("");
                    let credentials = format!("{}:{}", email, creds.token);
                    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
                    request.header("Authorization", format!("Basic {}", auth))
                }
                "azuredevops" => {
                    let credentials = format!(":{}", creds.token);
                    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
                    request.header("Authorization", format!("Basic {}", auth))
                }
                "gitea" | "forgejo" => {
                    request.header("Authorization", format!("token {}", creds.token))
                }
                _ => request,
            };
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Download error: {}", e))
}

async fn fetch_jira_attachment(
    app_state: &AppState,
    project_id: i32,
    attachment_id: &str,
) -> Result<Vec<u8>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    let config: ProjectConfig =
        crate::core::read_maestro_json(&git_conn, crate::project::settings::SETTINGS_FILE).await;
    let ticketing = config
        .issue_tracking
        .ok_or_else(|| "No ticketing provider configured".to_string())?;

    if ticketing.provider != "jira_cloud" {
        return Err(format!(
            "attachment: scheme only supported for Jira, got {}",
            ticketing.provider
        ));
    }

    let creds = super::issue_tracking_handlers::get_integration_creds("jira_cloud", app_state)?;
    let site_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Jira Cloud: site_url missing".to_string())?;
    let email = creds
        .email
        .as_deref()
        .ok_or_else(|| "Jira Cloud: email missing".to_string())?;

    let url = format!(
        "{}/rest/api/3/attachment/content/{}",
        site_url, attachment_id
    );
    let credentials = format!("{}:{}", email, creds.token);
    let auth = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());

    let client = crate::integration::build_http_client()?;
    let response = client
        .get(&url)
        .header("Authorization", format!("Basic {}", auth))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Jira attachment fetch failed: HTTP {}",
            response.status()
        ));
    }

    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Download error: {}", e))
}

async fn read_local_or_remote_image(
    app_state: &AppState,
    project_id: i32,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let (project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;

    // std::path::Path::is_absolute() returns false on Windows for Unix-style paths like /home/...
    // so also check starts_with('/') to handle remote/WSL project paths correctly.
    let full_path = if file_path.starts_with('/') || std::path::Path::new(file_path).is_absolute() {
        file_path.to_string()
    } else {
        format!("{}/{}", project.path.trim_end_matches('/'), file_path)
    };

    if git_conn.is_on_this_machine() {
        return tokio::fs::read(&full_path)
            .await
            .map_err(|e| format!("Cannot read image file: {}", e));
    }

    // One path for SSH, WSL and containers. This replaced an SSH-only SFTP download into a
    // permanent on-disk cache keyed by path hash, which never revalidated — an image edited on
    // the host kept serving the first version it ever saw.
    let encoded = crate::connectivity::files::read_binary(&git_conn, &full_path).await?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("Cannot decode image from {}: {}", full_path, e))
}

fn mime_from_bytes_or_url(bytes: &[u8], url: &str) -> &'static str {
    if bytes.starts_with(b"<svg") || bytes.starts_with(b"<SVG") {
        return "image/svg+xml";
    }
    if bytes.len() >= 12 {
        if bytes.starts_with(b"\x89PNG") {
            return "image/png";
        }
        if bytes.starts_with(b"\xFF\xD8\xFF") {
            return "image/jpeg";
        }
        if bytes.starts_with(b"GIF8") {
            return "image/gif";
        }
        if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
            return "image/webp";
        }
    }
    let lower = url.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/png"
    }
}
