use rusqlite::Result as SqliteResult;
use rusqlite::ToSql;
use rusqlite::types::{FromSql, FromSqlResult, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Saved SSH connection for quick reconnection
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SshConnection {
    pub id: i32,
    pub connection_string: String,  // e.g., "user@host:22"
    pub username: String,
    pub host: String,
    pub port: u16,
    pub auth_method: SshAuthMethod,  // Serialized SshAuthMethod
    pub display_name: Option<String>,  // User-friendly name
    pub last_used_at: String,  // ISO 8601
    pub created_at: String,    // ISO 8601
}

/// SSH authentication method configuration
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum SshAuthMethod {
    /// Authenticate using a private key file
    #[serde(rename = "KeyFile")]
    KeyFile { path: String, save_passphrase: bool },
    /// Authenticate using SSH agent
    #[serde(rename = "Agent")]
    Agent,
    /// Authenticate using password (stored in OS keyring)
    #[serde(rename = "Password")]
    Password { save_password: bool }
}

/// SSH connection state machine
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshConnectionState {
    Initial,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// Payload for ssh-reconnecting Tauri events
#[derive(Clone, Serialize)]
pub struct ReconnectingPayload {
    pub connection_id: i32,
    pub attempt: usize,
    pub max_attempts: usize,
}

impl ToSql for SshAuthMethod {
    fn to_sql(&self) -> SqliteResult<ToSqlOutput<'_>> {
        let json = serde_json::to_string(self)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(ToSqlOutput::from(json))
    }
}

impl FromSql for SshAuthMethod {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let json = value.as_str()?;

        if json.is_empty() {
            return Err(rusqlite::types::FromSqlError::Other(
                "SshAuthMethod cannot be deserialized from empty string".into()
            ));
        }

        serde_json::from_str(json).map_err(|e| {
            rusqlite::types::FromSqlError::Other(
                format!("Failed to deserialize SshAuthMethod from JSON: '{}'. Error: {}", json, e).into()
            )
        })
    }
}

impl SshConnection {
    /// Parse an SshConnection from a rusqlite Row
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(SshConnection {
            id: row.get(0)?,
            connection_string: row.get(1)?,
            username: row.get(2)?,
            host: row.get(3)?,
            port: row.get(4)?,
            auth_method: row.get(5)?,
            display_name: row.get(6)?,
            last_used_at: row.get(7)?,
            created_at: row.get(8)?,
        })
    }
}
