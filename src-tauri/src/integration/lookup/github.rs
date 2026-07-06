use std::sync::Arc;

use tauri::State;

use crate::core::AppState;
use crate::models::issue_tracking::RepoOption;

/// Check whether a GitHub user or organization exists. Returns true if found, false if not.
#[tauri::command]
#[specta::specta]
pub async fn check_github_owner(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<bool, String> {
    let token = super::get_github_token(&app_state).await?;
    let client = crate::integration::build_http_client()?;
    let url = format!("https://api.github.com/users/{}", urlencoding::encode(&owner));
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "maestro/1.0")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    match response.status().as_u16() {
        200 => Ok(true),
        404 => Ok(false),
        status => Err(format!("GitHub API error {}", status)),
    }
}

/// List repositories for a GitHub user or organization.
#[tauri::command]
#[specta::specta]
pub async fn list_github_repos(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<Vec<RepoOption>, String> {
    let token = super::get_github_token(&app_state).await?;
    let client = crate::integration::build_http_client()?;
    let auth = format!("Bearer {}", token);
    let base_url = format!(
        "https://api.github.com/users/{}/repos?sort=updated",
        urlencoding::encode(&owner),
    );

    #[derive(serde::Deserialize)]
    struct GhRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<GhRepo> = super::fetch_all_pages(
        &client,
        &base_url,
        &[("Authorization", auth.as_str()), ("User-Agent", "maestro/1.0")],
        "page",
        "per_page",
        100,
        "GitHub",
    )
    .await?;

    Ok(repos
        .into_iter()
        .map(|r| RepoOption { name: r.name, description: r.description, clone_url: r.clone_url })
        .collect())
}
