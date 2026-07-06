use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::models::issue_tracking::RepoOption;

/// List Forgejo repositories for the authenticated user or a given owner.
#[tauri::command]
#[specta::specta]
pub async fn list_forgejo_repos(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<Vec<RepoOption>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("forgejo", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Forgejo: instance_url missing from stored credentials".to_string())?;
    let base = crate::integration::normalize_instance_url(instance_url);

    let client = crate::integration::build_http_client()?;
    let auth = format!("token {}", creds.token);
    let base_url = format!(
        "{}/api/v1/users/{}/repos?sort=updated",
        base,
        urlencoding::encode(&owner),
    );

    #[derive(serde::Deserialize)]
    struct ForgejoRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<ForgejoRepo> = super::fetch_all_pages(
        &client,
        &base_url,
        &[("Authorization", auth.as_str())],
        "page",
        "limit",
        50,
        "Forgejo",
    )
    .await?;

    Ok(repos
        .into_iter()
        .map(|r| RepoOption { name: r.name, description: r.description, clone_url: r.clone_url })
        .collect())
}

/// List Gitea repositories for the given owner.
#[tauri::command]
#[specta::specta]
pub async fn list_gitea_repos(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<Vec<RepoOption>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("gitea", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Gitea: instance_url missing from stored credentials".to_string())?;
    let base = crate::integration::normalize_instance_url(instance_url);

    let client = crate::integration::build_http_client()?;
    let auth = format!("token {}", creds.token);
    let base_url = format!(
        "{}/api/v1/users/{}/repos?sort=updated",
        base,
        urlencoding::encode(&owner),
    );

    #[derive(serde::Deserialize)]
    struct GiteaRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<GiteaRepo> = super::fetch_all_pages(
        &client,
        &base_url,
        &[("Authorization", auth.as_str())],
        "page",
        "limit",
        50,
        "Gitea",
    )
    .await?;

    Ok(repos
        .into_iter()
        .map(|r| RepoOption { name: r.name, description: r.description, clone_url: r.clone_url })
        .collect())
}
