use std::sync::Arc;

use base64::Engine as _;
use tauri::{Emitter, State};

use crate::core::AppState;
use crate::models::integration::{CredentialSource, IntegrationCredentials, IntegrationStatus};
use crate::models::project::now_rfc3339;
use crate::integration::keychain::{KeychainOutcome, KeychainStore};
use crate::integration::normalize_instance_url;

const KNOWN_PROVIDERS: &[&str] = &[
    "github",
    "gitlab",
    "forgejo",
    "gitea",
    "linear",
    "jira_cloud",
    "azuredevops",
    "bitbucket",
];

/// Probe all known provider keys in the keyring and return their connection status.
/// For GitHub, also probes the gh CLI as a fallback credential source.
/// Raw tokens are never returned — only IntegrationStatus (D-01 security constraint).
#[tauri::command]
#[specta::specta]
pub async fn list_integrations(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<IntegrationStatus>, String> {
    let mut statuses = Vec::with_capacity(KNOWN_PROVIDERS.len());

    for &provider in KNOWN_PROVIDERS {
        let outcome = KeychainStore::get_integration(provider, &app_state.app_data_dir);
        match outcome {
            Ok(KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds))) => {
                statuses.push(IntegrationStatus {
                    provider: provider.to_string(),
                    connected: true,
                    display_name: creds.display_name,
                    source: Some(creds.source),
                    instance_url: creds.instance_url,
                });
            }
            Ok(KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None)) => {
                if provider == "github" {
                    // gh CLI is an ephemeral credential source — re-probed each call,
                    // never stored in keyring (per D-18 and RESEARCH.md Pitfall 3).
                    if let Some(_token) = crate::integration::github::try_gh_cli_token().await {
                        let display_name = crate::integration::github::try_gh_cli_display_name().await;
                        statuses.push(IntegrationStatus {
                            provider: provider.to_string(),
                            connected: true,
                            display_name,
                            source: Some(CredentialSource::GhCli),
                            instance_url: None,
                        });
                        continue;
                    }
                }
                statuses.push(IntegrationStatus {
                    provider: provider.to_string(),
                    connected: false,
                    display_name: None,
                    source: None,
                    instance_url: None,
                });
            }
            Err(_) => {
                statuses.push(IntegrationStatus {
                    provider: provider.to_string(),
                    connected: false,
                    display_name: None,
                    source: None,
                    instance_url: None,
                });
            }
        }
    }

    Ok(statuses)
}

/// Validate credentials against the provider API and store them globally in the keyring.
/// Returns the display name from the provider on success.
/// Raw tokens are never returned to the frontend (D-01).
#[tauri::command]
#[specta::specta]
pub async fn save_integration(
    app_state: State<'_, Arc<AppState>>,
    provider: String,
    token: String,
    instance_url: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    // T-55-02: Validate provider is in the allowlist before any keychain operation.
    if !KNOWN_PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("Unknown provider: {}", provider));
    }

    let display_name =
        validate_credentials(&provider, &token, instance_url.as_deref(), email.as_deref()).await?;

    let creds = IntegrationCredentials {
        token,
        instance_url,
        email,
        display_name: Some(display_name.clone()),
        connected_at: now_rfc3339(),
        source: CredentialSource::Manual,
    };

    let outcome = KeychainStore::store_integration(&provider, &creds, &app_state.app_data_dir)?;

    if matches!(outcome, KeychainOutcome::FileFallback(_)) {
        app_state
            .app_handle
            .emit("ticketing:keyring-unavailable", ())
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(display_name)
}

/// Remove stored credentials for a provider from the keyring and file fallback.
#[tauri::command]
#[specta::specta]
pub async fn delete_integration(
    app_state: State<'_, Arc<AppState>>,
    provider: String,
) -> Result<(), String> {
    KeychainStore::delete_integration(&provider, &app_state.app_data_dir)?;
    Ok(())
}

/// Validate credentials against the provider API without storing them.
/// Returns the display name from the provider on success.
#[tauri::command]
#[specta::specta]
pub async fn test_integration(
    provider: String,
    token: String,
    instance_url: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    validate_credentials(&provider, &token, instance_url.as_deref(), email.as_deref()).await
}

/// Validate credentials for a given provider and return the display name.
/// All HTTP requests use a 15-second timeout. instance_url is normalized via
/// normalize_instance_url() before use (T-55-03).
async fn validate_credentials(
    provider: &str,
    token: &str,
    instance_url: Option<&str>,
    email: Option<&str>,
) -> Result<String, String> {
    let client = crate::integration::build_http_client()?;

    match provider {
        "github" => {
            #[derive(serde::Deserialize)]
            struct GitHubUser {
                login: String,
            }

            let response = client
                .get("https://api.github.com/user")
                .header("Authorization", format!("Bearer {}", token))
                .header("User-Agent", "maestro/1.0")
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("github: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("github: API error {}", status.as_u16()));
            }
            let user: GitHubUser = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;
            Ok(user.login)
        }

        "gitlab" => {
            #[derive(serde::Deserialize)]
            struct GitLabUser {
                username: String,
            }

            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "gitlab: instance_url required".to_string())?,
            );
            let response = client
                .get(format!("{}/api/v4/user", base))
                .header("PRIVATE-TOKEN", token)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("gitlab: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("gitlab: API error {}", status.as_u16()));
            }
            let user: GitLabUser = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse GitLab response: {}", e))?;
            Ok(user.username)
        }

        "forgejo" => {
            #[derive(serde::Deserialize)]
            struct ForgejoUser {
                login: String,
            }

            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "forgejo: instance_url required".to_string())?,
            );
            let response = client
                .get(format!("{}/api/v1/user", base))
                .header("Authorization", format!("token {}", token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("forgejo: bad credentials".to_string());
            }
            if response.status().as_u16() == 403 {
                return Err(
                    "forgejo: token is valid but missing the required 'read:user' scope. \
                     Regenerate your token with 'read:user' permission enabled."
                        .to_string(),
                );
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("forgejo: API error {}", status.as_u16()));
            }
            let user: ForgejoUser = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Forgejo response: {}", e))?;
            Ok(user.login)
        }

        "linear" => {
            #[derive(serde::Deserialize)]
            struct LinearViewerData {
                viewer: LinearViewer,
            }
            #[derive(serde::Deserialize)]
            struct LinearViewer {
                name: String,
            }

            let body = serde_json::json!({ "query": "{ viewer { id name } }" });
            let response = client
                .post("https://api.linear.app/graphql")
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("linear: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("linear: API error {}", status.as_u16()));
            }
            let gql: graphql_client::Response<LinearViewerData> = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Linear response: {}", e))?;
            if let Some(errors) = &gql.errors {
                if !errors.is_empty() {
                    return Err(format!("linear: {}", errors[0].message));
                }
            }
            let name = gql
                .data
                .ok_or_else(|| "linear: empty response".to_string())?
                .viewer
                .name;
            Ok(name)
        }

        "jira_cloud" => {
            #[derive(serde::Deserialize)]
            struct JiraMyselfResponse {
                #[serde(rename = "displayName")]
                display_name: Option<String>,
                #[serde(rename = "emailAddress")]
                email_address: Option<String>,
            }

            let email_str =
                email.ok_or_else(|| "jira_cloud: email required".to_string())?;
            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "jira_cloud: instance_url required".to_string())?,
            );
            let credentials = format!("{}:{}", email_str, token);
            let auth = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
            );
            let response = client
                .get(format!("{}/rest/api/3/myself", base))
                .header("Authorization", auth)
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("jira_cloud: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("jira_cloud: API error {}", status.as_u16()));
            }
            let user: JiraMyselfResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Jira Cloud response: {}", e))?;
            Ok(user
                .display_name
                .or(user.email_address)
                .unwrap_or_else(|| "unknown".to_string()))
        }

        "jira_server" => {
            #[derive(serde::Deserialize)]
            struct JiraServerMyselfResponse {
                #[serde(rename = "displayName")]
                display_name: Option<String>,
            }

            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "jira_server: instance_url required".to_string())?,
            );
            let response = client
                .get(format!("{}/rest/api/2/myself", base))
                .header("Authorization", format!("Bearer {}", token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("jira_server: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("jira_server: API error {}", status.as_u16()));
            }
            let user: JiraServerMyselfResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Jira Server response: {}", e))?;
            Ok(user.display_name.unwrap_or_else(|| "unknown".to_string()))
        }

        "azuredevops" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct AzdoConnectionDataResponse {
                authenticated_user: AzdoAuthUser,
            }
            #[derive(serde::Deserialize)]
            struct AzdoAuthUser {
                #[serde(rename = "providerDisplayName")]
                provider_display_name: Option<String>,
                #[serde(rename = "subjectDescriptor")]
                subject_descriptor: Option<String>,
            }

            let base = crate::integration::azure_devops::normalize_azdo_org_url(
                instance_url.ok_or_else(|| "azuredevops: instance_url required".to_string())?,
            );
            let credentials = format!(":{}", token);
            let auth = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
            );
            let response = client
                .get(format!("{}/_apis/connectionData?api-version={}", base, crate::integration::azure_devops::AZDO_API_VERSION))
                .header("Authorization", auth)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("Azure DevOps: invalid or expired credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
                return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
            }
            let conn_data: AzdoConnectionDataResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Azure DevOps response: {}", e))?;
            Ok(conn_data
                .authenticated_user
                .provider_display_name
                .or(conn_data.authenticated_user.subject_descriptor)
                .unwrap_or_else(|| "unknown".to_string()))
        }

        "gitea" => {
            #[derive(serde::Deserialize)]
            struct GiteaUser {
                login: String,
            }

            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "gitea: instance_url required".to_string())?,
            );
            let response = client
                .get(format!("{}/api/v1/user", base))
                .header("Authorization", format!("token {}", token))
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("gitea: bad credentials".to_string());
            }
            if response.status().as_u16() == 403 {
                return Err(
                    "gitea: token is valid but missing the required 'read:user' scope. \
                     Regenerate your token with 'read:user' permission enabled."
                        .to_string(),
                );
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("gitea: API error {}", status.as_u16()));
            }
            let user: GiteaUser = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Gitea response: {}", e))?;
            Ok(user.login)
        }

        "bitbucket" => {
            match instance_url {
                None => {
                    // Cloud: email + app password, Basic auth
                    #[derive(serde::Deserialize)]
                    struct BitbucketCloudUser {
                        display_name: String,
                    }

                    let email_str =
                        email.ok_or_else(|| "bitbucket: email required".to_string())?;
                    let credentials = format!("{}:{}", email_str, token);
                    let auth = format!(
                        "Basic {}",
                        base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
                    );
                    let response = client
                        .get("https://api.bitbucket.org/2.0/user")
                        .header("Authorization", auth)
                        .send()
                        .await
                        .map_err(|e| format!("Network error: {}", e))?;

                    if response.status().as_u16() == 401 {
                        return Err("bitbucket: bad credentials".to_string());
                    }
                    if !response.status().is_success() {
                        let status = response.status();
                        return Err(format!("bitbucket: API error {}", status.as_u16()));
                    }
                    let user: BitbucketCloudUser = response
                        .json()
                        .await
                        .map_err(|e| format!("Failed to parse Bitbucket response: {}", e))?;
                    Ok(user.display_name)
                }
                Some(url) => {
                    #[derive(serde::Deserialize)]
                    struct BitbucketServerUser {
                        #[serde(rename = "displayName")]
                        display_name: Option<String>,
                        slug: Option<String>,
                    }

                    let base = normalize_instance_url(url);
                    let bearer = format!("Bearer {}", token);

                    // Step 1: /plugins/servlet/applinks/whoami → authenticated username
                    let whoami_response = client
                        .get(format!("{}/plugins/servlet/applinks/whoami", base))
                        .header("Authorization", &bearer)
                        .send()
                        .await
                        .map_err(|e| format!("Network error: {}", e))?;

                    if whoami_response.status().as_u16() == 401 {
                        return Err("bitbucket: bad credentials".to_string());
                    }
                    if !whoami_response.status().is_success() {
                        let status = whoami_response.status();
                        return Err(format!("bitbucket: API error {}", status.as_u16()));
                    }
                    let username = whoami_response
                        .text()
                        .await
                        .map_err(|e| format!("Failed to read whoami response: {}", e))?
                        .trim()
                        .to_string();

                    if username.is_empty() {
                        return Err("bitbucket: could not determine authenticated user".to_string());
                    }

                    // Step 2: get display name from user details
                    let user_response = client
                        .get(format!("{}/rest/api/latest/users/{}", base, username))
                        .header("Authorization", &bearer)
                        .send()
                        .await
                        .map_err(|e| format!("Network error: {}", e))?;

                    if user_response.status().is_success() {
                        let user: BitbucketServerUser = user_response
                            .json()
                            .await
                            .map_err(|e| format!("Failed to parse user response: {}", e))?;
                        Ok(user.display_name.or(user.slug).unwrap_or(username))
                    } else {
                        Ok(username)
                    }
                }
            }
        }

        unknown => Err(format!("Unknown provider: {}", unknown)),
    }
}
