use std::sync::Arc;

use base64::Engine as _;
use tauri::State;

use crate::core::AppState;
use crate::models::issue_tracking::{
    AzureDevOpsProjectOption, AzureDevOpsRepoOption, BitbucketProjectOption, BitbucketRepoOption,
    JiraProjectOption,
};

/// List Jira Cloud projects accessible to the authenticated user.
/// Starred/favourite projects are indicated via `is_favourite`.
#[tauri::command]
#[specta::specta]
pub async fn list_jira_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<JiraProjectOption>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("jira_cloud", &app_state)?;
    let site_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Jira Cloud: site_url missing from stored credentials".to_string())?;
    let email = creds
        .email
        .as_deref()
        .ok_or_else(|| "Jira Cloud: email missing from stored credentials".to_string())?;
    let base = crate::integration::normalize_instance_url(site_url);

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

/// List Azure DevOps projects for the authenticated organization.
#[tauri::command]
#[specta::specta]
pub async fn list_azuredevops_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<AzureDevOpsProjectOption>, String> {
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("azuredevops", &app_state)?;
    let org_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Azure DevOps: org_url missing from stored credentials".to_string())?;
    let base = crate::integration::azure_devops::normalize_azdo_org_url(org_url);

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
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("azuredevops", &app_state)?;
    let org_url = creds
        .instance_url
        .as_deref()
        .ok_or_else(|| "Azure DevOps: org_url missing from stored credentials".to_string())?;
    let base = crate::integration::azure_devops::normalize_azdo_org_url(org_url);

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
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("bitbucket", &app_state)?;
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
                start = next_start.unwrap_or(0);
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
    let creds = crate::integration::issue_tracking_handlers::get_integration_creds("bitbucket", &app_state)?;
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
        start = next_start.unwrap_or(0);
    }

    Ok(all_projects
        .into_iter()
        .map(|p| BitbucketProjectOption { key: p.key, name: p.name })
        .collect())
}
