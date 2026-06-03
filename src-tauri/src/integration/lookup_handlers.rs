use std::sync::Arc;

use base64::Engine as _;
use tauri::State;

use crate::core::AppState;
use crate::integration::keychain::{KeychainOutcome, KeychainStore};
use crate::models::issue_tracking::{
    AzureDevOpsProjectOption, AzureDevOpsRepoOption, BitbucketProjectOption, BitbucketRepoOption,
    GitLabProjectOption, JiraProjectOption, RepoOption,
};
use crate::integration::linear::LinearTeam;
use super::issue_tracking_handlers::get_integration_creds;

/// Paginated fetch for APIs returning a flat JSON array with page-based pagination.
/// Loops from page 1 until an empty response, appending `{limit_param}=N&{page_param}=N`
/// to `base_url` each iteration.
async fn fetch_all_pages<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base_url: &str,
    headers: &[(&str, &str)],
    page_param: &str,
    limit_param: &str,
    limit_value: u32,
    provider_name: &str,
) -> Result<Vec<T>, String> {
    let mut all_items = Vec::new();
    let mut page = 1u32;
    let joiner = if base_url.contains('?') { '&' } else { '?' };

    loop {
        let url = format!(
            "{}{}{page_param}={page}&{limit_param}={limit_value}",
            base_url, joiner,
        );

        let mut request = client.get(&url);
        for &(name, value) in headers {
            request = request.header(name, value);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("{} API error {}", provider_name, response.status().as_u16()));
        }

        let items: Vec<T> = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse {} response: {}", provider_name, e))?;

        if items.is_empty() {
            break;
        }
        all_items.extend(items);
        page += 1;
    }

    Ok(all_items)
}

async fn get_github_token(app_state: &AppState) -> Result<String, String> {
    match KeychainStore::get_integration("github", &app_state.app_data_dir)? {
        KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
            Ok(creds.token)
        }
        KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
            crate::integration::github::try_gh_cli_token()
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
    let token = get_github_token(&app_state).await?;
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

    let repos: Vec<GhRepo> = fetch_all_pages(
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
    let base = crate::integration::normalize_instance_url(site_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", email, creds.token).as_bytes())
    );

    let client = crate::integration::build_http_client()?;
    let max_results = 50u32;

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

    let mut all_projects = Vec::new();
    let mut start_at = 0u32;

    loop {
        let url = format!(
            "{}/rest/api/3/project/search?maxResults={}&startAt={}&orderBy=name&expand=insight",
            base, max_results, start_at,
        );
        let response = client
            .get(&url)
            .header("Authorization", &auth)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Jira Cloud API error {}", response.status().as_u16()));
        }

        let result: JiraSearchResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Jira projects response: {}", e))?;

        if result.values.is_empty() {
            break;
        }
        start_at += result.values.len() as u32;
        all_projects.extend(result.values);
    }

    Ok(all_projects
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
    crate::integration::linear::list_teams(&creds.token).await
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

    let projects: Vec<GitLabProject> = fetch_all_pages(
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

    let repos: Vec<ForgejoRepo> = fetch_all_pages(
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
    let creds = get_integration_creds("gitea", &app_state)?;
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

    let repos: Vec<GiteaRepo> = fetch_all_pages(
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
    let base = crate::integration::azure_devops::normalize_azdo_org_url(org_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!(":{}", creds.token).as_bytes())
    );

    let client = crate::integration::build_http_client()?;
    let top = 50u32;

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

    let mut all_projects = Vec::new();
    let mut skip = 0u32;

    loop {
        let url = format!(
            "{}/_apis/projects?api-version={}&$top={}&$skip={}",
            base, crate::integration::azure_devops::AZDO_API_VERSION, top, skip,
        );
        let response = client
            .get(&url)
            .header("Authorization", &auth)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
            return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
        }

        let result: AzdoProjectsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Azure DevOps projects response: {}", e))?;

        if result.value.is_empty() {
            break;
        }
        skip += result.value.len() as u32;
        all_projects.extend(result.value);
    }

    Ok(all_projects
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
    let base = crate::integration::azure_devops::normalize_azdo_org_url(org_url);

    use base64::Engine as _;
    let auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!(":{}", creds.token).as_bytes())
    );

    let client = crate::integration::build_http_client()?;
    let url = format!(
        "{}/{}/_apis/git/repositories?api-version={}",
        base,
        urlencoding::encode(&project),
        crate::integration::azure_devops::AZDO_API_VERSION,
    );
    let response = client
        .get(&url)
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
        return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
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
    let client = crate::integration::build_http_client()?;

    match creds.instance_url {
        Some(base_url) => {
            // Bitbucket Server / Data Center — uses isLastPage + nextPageStart
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
            #[serde(rename_all = "camelCase")]
            struct BbServerReposResponse {
                values: Vec<BbServerRepo>,
                #[serde(default)]
                is_last_page: bool,
                next_page_start: Option<u32>,
            }

            let auth = format!("Bearer {}", creds.token);
            let base = base_url.trim_end_matches('/');
            let mut all_repos = Vec::new();
            let mut start = 0u32;

            loop {
                let url = format!(
                    "{}/rest/api/latest/projects/{}/repos?limit=100&start={}",
                    base,
                    urlencoding::encode(&workspace),
                    start,
                );
                let response = client
                    .get(&url)
                    .header("Authorization", &auth)
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

                let is_last = result.is_last_page;
                let next_start = result.next_page_start;
                all_repos.extend(result.values);

                if is_last || next_start.is_none() {
                    break;
                }
                start = next_start.expect("checked above");
            }

            Ok(all_repos
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
            // Bitbucket Cloud — follows `next` URL
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
                next: Option<String>,
            }

            let mut all_repos = Vec::new();
            let mut url = format!(
                "https://api.bitbucket.org/2.0/repositories/{}?pagelen=50&sort=-updated_on",
                urlencoding::encode(&workspace),
            );

            loop {
                let response = client
                    .get(&url)
                    .header("Authorization", &auth)
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

                let next_url = result.next;
                all_repos.extend(result.values);

                match next_url {
                    Some(next) => url = next,
                    None => break,
                }
            }

            Ok(all_repos
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
    let client = crate::integration::build_http_client()?;
    let auth = format!("Bearer {}", creds.token);

    #[derive(serde::Deserialize)]
    struct BbProject {
        key: String,
        name: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BbProjectsResponse {
        values: Vec<BbProject>,
        #[serde(default)]
        is_last_page: bool,
        next_page_start: Option<u32>,
    }

    let base = base_url.trim_end_matches('/');
    let mut all_projects = Vec::new();
    let mut start = 0u32;

    loop {
        let url = format!("{}/rest/api/latest/projects?limit=100&start={}", base, start);
        let response = client
            .get(&url)
            .header("Authorization", &auth)
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

        let is_last = result.is_last_page;
        let next_start = result.next_page_start;
        all_projects.extend(result.values);

        if is_last || next_start.is_none() {
            break;
        }
        start = next_start.expect("checked above");
    }

    Ok(all_projects
        .into_iter()
        .map(|p| BitbucketProjectOption { key: p.key, name: p.name })
        .collect())
}
