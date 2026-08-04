use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::acp::ConnectionKey;
use crate::connectivity::exec_channel::{run_on, ExecTarget};
use crate::connectivity::files;
use crate::git::exec::git_prefix_args;
use crate::models::GitConnection;
use super::crud::register_project_in_db;

/// Resolve the three optional connection columns the project-creation IPC commands carry into
/// the connection every operation below runs through.
async fn connection_at(
    app_state: &AppState,
    path: &str,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
) -> Result<GitConnection, String> {
    let key = ConnectionKey::from_all_ids(connection_id, wsl_connection_id, docker_connection_id);
    crate::core::git_connection_for(app_state, path.to_string(), key).await
}

/// Run `git <prefix> <args>` on a connection, returning stderr on failure.
async fn git(conn: &GitConnection, args: &[&str], what: &str) -> Result<(), String> {
    let mut argv = git_prefix_args(&ExecTarget::of(conn)).to_vec();
    argv.extend_from_slice(args);
    let output = run_on(conn, None, "git", &argv).await?;
    if output.success() {
        Ok(())
    } else {
        Err(format!("{} failed: {}", what, output.stderr_string()))
    }
}

/// Initialize git in an existing directory (no-op if already a git repo)
#[tauri::command]
#[specta::specta]
pub async fn git_init_project(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
) -> Result<(), String> {
    let conn =
        connection_at(&app_state, &path, connection_id, wsl_connection_id, docker_connection_id).await?;
    if inside_work_tree(&conn, &path).await {
        return Ok(());
    }
    git(&conn, &["init", "-b", "main", &path], "git init").await
}

/// `git rev-parse --is-inside-work-tree` detects both repository roots and subdirectories of one,
/// which a `.git` existence check does not.
async fn inside_work_tree(conn: &GitConnection, path: &str) -> bool {
    let mut argv = git_prefix_args(&ExecTarget::of(conn)).to_vec();
    argv.extend_from_slice(&["-C", path, "rev-parse", "--is-inside-work-tree"]);
    // A transport error or a host with no git installed both mean "not a repository" here.
    run_on(conn, None, "git", &argv).await.map(|out| out.success()).unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub async fn check_is_git_repo(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
) -> Result<bool, String> {
    is_git_repo(&app_state, path, connection_id, wsl_connection_id, docker_connection_id).await
}

/// Non-IPC form of [`check_is_git_repo`], so callers that already hold an `AppState` can gate
/// on it without going back through the command layer.
pub async fn is_git_repo(
    app_state: &AppState,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
) -> Result<bool, String> {
    let conn =
        connection_at(app_state, &path, connection_id, wsl_connection_id, docker_connection_id).await?;
    Ok(inside_work_tree(&conn, &path).await)
}

async fn build_provider_auth_header(
    provider: &str,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    // GitHub supports a fallback to the `gh` CLI token when no keychain entry exists.
    let token_result = if provider == "github" {
        match crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state) {
            Ok(creds) => Ok(creds.token),
            Err(_) => crate::integration::github::try_gh_cli_token()
                .await
                .ok_or_else(|| "No GitHub credentials found".to_string()),
        }
    } else {
        crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)
            .map(|creds| creds.token)
    };

    let header = match provider {
        "github" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("x-access-token:{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        "gitlab" => format!("Authorization: Bearer {}", token_result?),
        "bitbucket" => {
            let creds = crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)?;
            match creds.instance_url {
                Some(_) => format!("Authorization: Bearer {}", creds.token),
                None => {
                    let email = creds.email.ok_or("Bitbucket Cloud credentials missing email")?;
                    let basic = base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{}", email, creds.token).as_bytes());
                    format!("Authorization: Basic {}", basic)
                }
            }
        }
        "forgejo" | "gitea" => format!("Authorization: token {}", token_result?),
        "azuredevops" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!(":{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        _ => return Ok(None),
    };

    Ok(Some(header))
}

/// Clone a git repository and register it as a project
#[tauri::command]
#[specta::specta]
pub async fn clone_project(
    app_state: State<'_, Arc<AppState>>,
    url: String,
    target_path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
    provider: Option<String>,
) -> Result<crate::models::Project, String> {
    let connection_key = ConnectionKey::from_all_ids(connection_id, wsl_connection_id, docker_connection_id);
    let auth_header = match provider.as_deref() {
        Some(provider_key) if url.starts_with("http://") || url.starts_with("https://") => {
            build_provider_auth_header(provider_key, &app_state).await?
        }
        _ => None,
    };

    let conn =
        connection_at(&app_state, &target_path, connection_id, wsl_connection_id, docker_connection_id)
            .await?;

    // The header carries a credential, so it goes as its own argv entry rather than into a
    // shell string where quoting is the only thing keeping it intact.
    let header_arg = auth_header.map(|header| format!("http.extraHeader={}", header));
    let mut args: Vec<&str> = Vec::new();
    if let Some(ref header) = header_arg {
        args.extend_from_slice(&["-c", header]);
    }
    args.extend_from_slice(&["clone", &url, &target_path]);
    git(&conn, &args, "git clone").await?;

    let name = std::path::Path::new(&target_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    register_project_in_db(app_state.inner(), &target_path, &name, connection_key).await
}

/// Create a new project directory, git init it, and register as a project
#[tauri::command]
#[specta::specta]
pub async fn create_new_project(
    app_state: State<'_, Arc<AppState>>,
    parent_dir: String,
    folder_name: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    docker_connection_id: Option<i32>,
) -> Result<crate::models::Project, String> {
    let connection_key = ConnectionKey::from_all_ids(connection_id, wsl_connection_id, docker_connection_id);
    // Build full path string (works for both local and remote — remote paths are POSIX)
    let full_path_str = format!("{}/{}", parent_dir.trim_end_matches('/'), folder_name);

    let conn = connection_at(
        &app_state,
        &full_path_str,
        connection_id,
        wsl_connection_id,
        docker_connection_id,
    )
    .await?;

    if files::dir_exists(&conn, &full_path_str).await {
        return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
    }
    files::create_dir_all(&conn, &full_path_str).await?;
    git(&conn, &["init", "-b", "main", &full_path_str], "git init").await?;

    register_project_in_db(app_state.inner(), &full_path_str, &folder_name, connection_key).await
}
