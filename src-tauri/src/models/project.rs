use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// SSH authentication method configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum SshAuthMethod {
    /// Authenticate using a private key file
    #[serde(rename = "KeyFile")]
    KeyFile { path: String },
    /// Authenticate using SSH agent
    #[serde(rename = "Agent")]
    Agent,
    /// Authenticate using password
    #[serde(rename = "Password")]
    Password { save_password: bool },
}

/// SSH configuration for remote projects
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshConfig {
    pub host: String,              // e.g., "example.com"
    pub port: u16,                 // SSH port, typically 22
    pub username: String,          // SSH username
    pub auth_method: SshAuthMethod, // Authentication method
    pub remote_path: String,       // Remote path e.g., "/home/user/project"
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub created_at: String,  // ISO 8601
    pub is_remote: bool,
    pub ssh_config: Option<SshConfig>,
}

impl Project {
    /// Get the connection type as a string
    pub fn connection_type(&self) -> String {
        if self.is_remote {
            "remote".to_string()
        } else {
            "local".to_string()
        }
    }

    /// Serialize SSH config to JSON string if present
    pub fn serialize_ssh_config(&self) -> Result<Option<String>, serde_json::Error> {
        self.ssh_config.as_ref().map_or(Ok(None), |cfg| {
            serde_json::to_string(cfg).map(Some)
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum ProjectStatus {
    Active,
    Archived,
}

/// Recent project with display metadata
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EnhancedRecentProject {
    pub path: String,
    pub name: String,
    pub is_remote: bool,
    pub host: Option<String>,
    pub username: Option<String>,
    pub last_opened: String,  // ISO 8601
}

/// Saved SSH connection for quick reconnection
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SshConnection {
    pub id: i32,
    pub connection_string: String,  // e.g., "user@host:22"
    pub username: String,
    pub host: String,
    pub port: u16,
    pub auth_method: String,  // Serialized SshAuthMethod
    pub last_used_at: String,  // ISO 8601
    pub created_at: String,    // ISO 8601
}
