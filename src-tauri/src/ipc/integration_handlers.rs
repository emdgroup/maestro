use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use tauri::{Emitter, State};

use crate::db::AppState;
use crate::models::integration::{CredentialSource, IntegrationCredentials, IntegrationStatus};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::keychain::{KeychainOutcome, KeychainStore};
use crate::ticketing::normalize_instance_url;

const KNOWN_PROVIDERS: &[&str] = &[
    "github",
    "gitlab",
    "forgejo",
    "linear",
    "jira_cloud",
    "azuredevops",
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
                });
            }
            Ok(KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None)) => {
                if provider == "github" {
                    // gh CLI is an ephemeral credential source — re-probed each call,
                    // never stored in keyring (per D-18 and RESEARCH.md Pitfall 3).
                    if let Some(_token) = crate::ticketing::github::try_gh_cli_token().await {
                        let display_name = crate::ticketing::github::try_gh_cli_display_name().await;
                        statuses.push(IntegrationStatus {
                            provider: provider.to_string(),
                            connected: true,
                            display_name,
                            source: Some(CredentialSource::GhCli),
                        });
                        continue;
                    }
                }
                statuses.push(IntegrationStatus {
                    provider: provider.to_string(),
                    connected: false,
                    display_name: None,
                    source: None,
                });
            }
            Err(_) => {
                statuses.push(IntegrationStatus {
                    provider: provider.to_string(),
                    connected: false,
                    display_name: None,
                    source: None,
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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

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

            let base = normalize_instance_url(
                instance_url.ok_or_else(|| "azuredevops: instance_url required".to_string())?,
            );
            let credentials = format!(":{}", token);
            let auth = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes())
            );
            let response = client
                .get(format!("{}/_apis/connectionData?api-version=7.1", base))
                .header("Authorization", auth)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if response.status().as_u16() == 401 {
                return Err("azuredevops: bad credentials".to_string());
            }
            if !response.status().is_success() {
                let status = response.status();
                return Err(format!("azuredevops: API error {}", status.as_u16()));
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

        unknown => Err(format!("Unknown provider: {}", unknown)),
    }
}
