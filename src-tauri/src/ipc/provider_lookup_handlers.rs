use std::sync::Arc;

use base64::Engine as _;
use tauri::State;

use crate::db::AppState;
use crate::issue_tracking::keychain::{KeychainOutcome, KeychainStore};
use crate::models::issue_tracking::{
    AzureDevOpsProjectOption, AzureDevOpsRepoOption, BitbucketProjectOption, BitbucketRepoOption,
    GitLabProjectOption, JiraProjectOption, RepoOption,
};
use crate::issue_tracking::linear::LinearTeam;
use super::issue_tracking_handlers::get_integration_creds;

async fn get_github_token(app_state: &AppState) -> Result<String, String> {
    match KeychainStore::get_integration("github", &app_state.app_data_dir)? {
        KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
            Ok(creds.token)
        }
        KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
            crate::issue_tracking::github::try_gh_cli_token()
                .await
                .ok_or_else(|| "No GitHub credentials found".to_string())
        }
    }
}

/// Check whether a GitHub user or organization exists. Returns true if found, false if not.
#[tauri::command]
#[specta::specta]
pub async fn check_github_owner(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<bool, String> {
    let token = get_github_token(&app_state).await?;
    let client = crate::issue_tracking::build_http_client()?;
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
    let token = get_github_token(&app_state).await?;
    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "https://api.github.com/users/{}/repos?per_page=100&sort=updated",
        urlencoding::encode(&owner),
    );
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "maestro/1.0")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct GhRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<GhRepo> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub repos response: {}", e))?;

    Ok(repos
        .into_iter()
        .map(|r| RepoOption { name: r.name, description: r.description, clone_url: r.clone_url })
        .collect())
}

/// List Jira Cloud projects accessible to the authenticated user.
/// Starred/favourite projects are indicated via `is_favourite`.
#[tauri::command]
#[specta::specta]
pub async fn list_jira_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<JiraProjectOption>, String> {
    let creds = get_integration_creds("jira_cloud", &app_state)?;
    let site_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Jira Cloud: site_url missing from stored credentials".to_string())?;
    let email = creds
        .email
        .as_deref()
        .ok_or_else(|| "Jira Cloud: email missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(site_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", email, creds.token).as_bytes())
    );

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "{}/rest/api/3/project/search?maxResults=50&orderBy=name&expand=insight",
        base
    );
    let response = client
        .get(&url)
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Jira Cloud API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct JiraAvatarUrls {
        #[serde(rename = "16x16")]
        small: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct JiraProject {
        key: String,
        name: String,
        #[serde(rename = "avatarUrls")]
        avatar_urls: Option<JiraAvatarUrls>,
        #[serde(default)]
        favourite: bool,
    }

    #[derive(serde::Deserialize)]
    struct JiraSearchResponse {
        values: Vec<JiraProject>,
    }

    let result: JiraSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira projects response: {}", e))?;

    Ok(result
        .values
        .into_iter()
        .map(|p| JiraProjectOption {
            key: p.key,
            name: p.name,
            avatar_url: p.avatar_urls.and_then(|a| a.small),
            is_favourite: p.favourite,
        })
        .collect())
}

/// List all Linear teams in the authenticated workspace.
#[tauri::command]
#[specta::specta]
pub async fn list_linear_teams(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<LinearTeam>, String> {
    let creds = get_integration_creds("linear", &app_state)?;
    crate::issue_tracking::linear::list_teams(&creds.token).await
}

/// List GitLab projects the authenticated user is a member of.
#[tauri::command]
#[specta::specta]
pub async fn list_gitlab_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<GitLabProjectOption>, String> {
    let creds = get_integration_creds("gitlab", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "GitLab: instance_url missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(instance_url);

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "{}/api/v4/projects?membership=true&per_page=50&order_by=last_activity_at",
        base
    );
    let response = client
        .get(&url)
        .header("PRIVATE-TOKEN", &creds.token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitLab API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct GitLabProject {
        id: i64,
        path_with_namespace: String,
        name: String,
        http_url_to_repo: Option<String>,
    }

    let projects: Vec<GitLabProject> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab projects response: {}", e))?;

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

/// List Forgejo repositories for the authenticated user or a given owner.
#[tauri::command]
#[specta::specta]
pub async fn list_forgejo_repos(
    app_state: State<'_, Arc<AppState>>,
    owner: String,
) -> Result<Vec<RepoOption>, String> {
    let creds = get_integration_creds("forgejo", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Forgejo: instance_url missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(instance_url);

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "{}/api/v1/users/{}/repos?limit=50",
        base,
        urlencoding::encode(&owner),
    );
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", creds.token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Forgejo API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct ForgejoRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<ForgejoRepo> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Forgejo repos response: {}", e))?;

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
    let creds = get_integration_creds("gitea", &app_state)?;
    let instance_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Gitea: instance_url missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(instance_url);

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "{}/api/v1/users/{}/repos?limit=50",
        base,
        urlencoding::encode(&owner),
    );
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", creds.token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Gitea API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct GiteaRepo {
        name: String,
        description: Option<String>,
        clone_url: Option<String>,
    }

    let repos: Vec<GiteaRepo> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gitea repos response: {}", e))?;

    Ok(repos
        .into_iter()
        .map(|r| RepoOption { name: r.name, description: r.description, clone_url: r.clone_url })
        .collect())
}

/// List Azure DevOps projects for the authenticated organization.
#[tauri::command]
#[specta::specta]
pub async fn list_azuredevops_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<AzureDevOpsProjectOption>, String> {
    let creds = get_integration_creds("azuredevops", &app_state)?;
    let org_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Azure DevOps: org_url missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(org_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!(":{}", creds.token).as_bytes())
    );

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!("{}/_apis/projects?api-version=7.1&$top=50", base);
    let response = client
        .get(&url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Azure DevOps API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    struct AzdoProject {
        id: String,
        name: String,
        description: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct AzdoProjectsResponse {
        value: Vec<AzdoProject>,
    }

    let result: AzdoProjectsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Azure DevOps projects response: {}", e))?;

    Ok(result
        .value
        .into_iter()
        .map(|p| AzureDevOpsProjectOption { id: p.id, name: p.name, description: p.description })
        .collect())
}

/// List git repositories within an Azure DevOps project.
#[tauri::command]
#[specta::specta]
pub async fn list_azuredevops_repos(
    app_state: State<'_, Arc<AppState>>,
    project: String,
) -> Result<Vec<AzureDevOpsRepoOption>, String> {
    let creds = get_integration_creds("azuredevops", &app_state)?;
    let org_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Azure DevOps: org_url missing from stored credentials".to_string())?;
    let base = crate::issue_tracking::normalize_instance_url(org_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!(":{}", creds.token).as_bytes())
    );

    let client = crate::issue_tracking::build_http_client()?;
    let url = format!(
        "{}/{}/_apis/git/repositories?api-version=7.1",
        base,
        urlencoding::encode(&project),
    );
    let response = client
        .get(&url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Azure DevOps API error {}", response.status().as_u16()));
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AzdoRepo {
        id: String,
        name: String,
        remote_url: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct AzdoReposResponse {
        value: Vec<AzdoRepo>,
    }

    let result: AzdoReposResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Azure DevOps repositories response: {}", e))?;

    Ok(result
        .value
        .into_iter()
        .map(|r| AzureDevOpsRepoOption {
            id: r.id,
            name: r.name.clone(),
            project_name: project.clone(),
            clone_url: r.remote_url,
        })
        .collect())
}

/// List repositories for a Bitbucket workspace (Cloud) or project key (Server/DC).
///
/// Cloud:  GET api.bitbucket.org/2.0/repositories/{workspace} — Basic auth (email:app_password)
/// Server: GET {instance_url}/rest/api/latest/projects/{project_key}/repos — Bearer token
#[tauri::command]
#[specta::specta]
pub async fn list_bitbucket_repos(
    app_state: State<'_, Arc<AppState>>,
    workspace: String,
) -> Result<Vec<BitbucketRepoOption>, String> {
    let creds = get_integration_creds("bitbucket", &app_state)?;
    let client = crate::issue_tracking::build_http_client()?;

    match creds.instance_url {
        Some(base_url) => {
            // Bitbucket Server / Data Center
            #[derive(serde::Deserialize)]
            struct BbServerCloneLink {
                href: String,
                name: String,
            }

            #[derive(serde::Deserialize)]
            struct BbServerLinks {
                #[serde(rename = "clone")]
                clone: Option<Vec<BbServerCloneLink>>,
            }

            #[derive(serde::Deserialize)]
            struct BbServerRepo {
                slug: String,
                name: String,
                links: Option<BbServerLinks>,
            }

            #[derive(serde::Deserialize)]
            struct BbServerReposResponse {
                values: Vec<BbServerRepo>,
            }

            let url = format!(
                "{}/rest/api/latest/projects/{}/repos?limit=100",
                base_url.trim_end_matches('/'),
                urlencoding::encode(&workspace),
            );
            let response = client
                .get(&url)
                .header("Authorization", format!("Bearer {}", creds.token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if !response.status().is_success() {
                return Err(format!("Bitbucket API error {}", response.status().as_u16()));
            }

            let result: BbServerReposResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket Server repositories response: {}", e))?;

            Ok(result
                .values
                .into_iter()
                .map(|r| {
                    let clone_url = r
                        .links
                        .as_ref()
                        .and_then(|l| l.clone.as_ref())
                        .and_then(|links| links.iter().find(|l| l.name == "http"))
                        .map(|l| l.href.clone());
                    BitbucketRepoOption {
                        slug: r.slug,
                        name: r.name,
                        description: None,
                        clone_url,
                    }
                })
                .collect())
        }
        None => {
            // Bitbucket Cloud
            let email = creds.email.ok_or_else(|| "Bitbucket Cloud credentials missing email".to_string())?;
            let auth = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", email, creds.token).as_bytes()),
            );

            #[derive(serde::Deserialize)]
            struct BbCloudCloneLink {
                href: String,
                name: String,
            }

            #[derive(serde::Deserialize)]
            struct BbCloudCloneLinks {
                #[serde(rename = "clone")]
                clone: Option<Vec<BbCloudCloneLink>>,
            }

            #[derive(serde::Deserialize)]
            struct BbCloudRepo {
                slug: String,
                name: String,
                description: Option<String>,
                links: Option<BbCloudCloneLinks>,
            }

            #[derive(serde::Deserialize)]
            struct BbCloudReposResponse {
                values: Vec<BbCloudRepo>,
            }

            let url = format!(
                "https://api.bitbucket.org/2.0/repositories/{}?pagelen=50&sort=-updated_on",
                urlencoding::encode(&workspace),
            );
            let response = client
                .get(&url)
                .header("Authorization", auth)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if !response.status().is_success() {
                return Err(format!("Bitbucket API error {}", response.status().as_u16()));
            }

            let result: BbCloudReposResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket repositories response: {}", e))?;

            Ok(result
                .values
                .into_iter()
                .map(|r| {
                    let clone_url = r
                        .links
                        .as_ref()
                        .and_then(|l| l.clone.as_ref())
                        .and_then(|links| links.iter().find(|l| l.name == "https"))
                        .map(|l| l.href.clone());
                    BitbucketRepoOption {
                        slug: r.slug,
                        name: r.name,
                        description: r.description,
                        clone_url,
                    }
                })
                .collect())
        }
    }
}

/// List projects in a Bitbucket Server / Data Center instance.
/// Returns an error for Bitbucket Cloud (no instance URL configured).
#[tauri::command]
#[specta::specta]
pub async fn list_bitbucket_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<BitbucketProjectOption>, String> {
    let creds = get_integration_creds("bitbucket", &app_state)?;
    let base_url = creds.instance_url.ok_or_else(|| {
        "list_bitbucket_projects is only available for Bitbucket Server/DC".to_string()
    })?;
    let client = crate::issue_tracking::build_http_client()?;

    #[derive(serde::Deserialize)]
    struct BbProject {
        key: String,
        name: String,
    }

    #[derive(serde::Deserialize)]
    struct BbProjectsResponse {
        values: Vec<BbProject>,
    }

    let url = format!("{}/rest/api/latest/projects?limit=100", base_url.trim_end_matches('/'));
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", creds.token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Bitbucket API error {}", response.status().as_u16()));
    }

    let result: BbProjectsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Bitbucket projects response: {}", e))?;

    Ok(result
        .values
        .into_iter()
        .map(|p| BitbucketProjectOption { key: p.key, name: p.name })
        .collect())
}
