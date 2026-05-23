use serde::{Deserialize, Serialize};
use specta::Type;

/// Returned to frontend via IPC — NEVER includes raw token (per D-01 security constraint)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct IntegrationStatus {
    pub provider: String,
    pub connected: bool,
    pub display_name: Option<String>,
    pub source: Option<CredentialSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum CredentialSource {
    Manual,
    GhCli,
}

/// Stored as JSON blob in keyring or encrypted file fallback. NOT exported to TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationCredentials {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub connected_at: String,
    pub source: CredentialSource,
}
