use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::models::issue_tracking::GitLabProjectOption;

/// List GitLab projects the authenticated user is a member of.
#[tauri::command]
#[specta::specta]
pub async fn list_gitlab_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<GitLabProjectOption>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("gitlab", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "GitLab: instance_url missing from stored credentials".to_string())?;
    let base = crate::integration::normalize_instance_url(instance_url);

    let client = crate::integration::build_http_client()?;
    let base_url = format!(
        "{}/api/v4/projects?membership=true&order_by=last_activity_at",
        base
    );

    #[derive(serde::Deserialize)]
    struct GitLabProject {
        id: i64,
        path_with_namespace: String,
        name: String,
        http_url_to_repo: Option<String>,
    }

    let projects: Vec<GitLabProject> = super::fetch_all_pages(
        &client,
        &base_url,
        &[("PRIVATE-TOKEN", creds.token.as_str())],
        "page",
        "per_page",
        50,
        "GitLab",
    )
    .await?;

    Ok(projects
        .into_iter()
        .map(|p| GitLabProjectOption {
            id: p.id,
            path_with_namespace: p.path_with_namespace,
            name: p.name,
            clone_url: p.http_url_to_repo,
        })
        .collect())
}
