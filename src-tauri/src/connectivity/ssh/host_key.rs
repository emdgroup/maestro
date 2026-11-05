//! SSH host keys, verified by trust on first use.
//!
//! The first connection to a `(host, port)` that authenticates pins the key the host presented, in
//! `known_hosts`. Every later handshake must present that key, or the connection is refused with
//! `SshError::HostKeyError` and never retried: a changed key is either a reinstalled host or
//! someone in the middle, and only the user can tell which. They clear the pin with "Forget host
//! key", and the next connect pins again.
//!
//! The key is stored only after authentication succeeds, so a mistyped address never pins one. A
//! certificate is pinned by the key inside it; its CA is not consulted.

use crate::connectivity::ssh::error::SshError;
use rusqlite::{Connection, OptionalExtension};
use russh::keys::{HashAlg, PublicKeyOrCertificate};

#[derive(Clone, Debug, PartialEq)]
pub struct HostKey {
    pub key_type: String,
    pub fingerprint: String,
}

impl HostKey {
    pub fn from_presented(presented: &PublicKeyOrCertificate) -> Self {
        let key_data = match presented {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data(),
            PublicKeyOrCertificate::Certificate(certificate) => certificate.public_key(),
        };
        Self {
            key_type: key_data.algorithm().as_str().to_string(),
            fingerprint: key_data.fingerprint(HashAlg::Sha256).to_string(),
        }
    }
}

pub(crate) fn accepts(pinned: Option<&HostKey>, presented: &HostKey) -> bool {
    pinned.is_none_or(|pinned| pinned.fingerprint == presented.fingerprint)
}

pub(crate) fn mismatch_error(
    host: &str,
    port: u16,
    pinned: &HostKey,
    presented: &HostKey,
) -> SshError {
    SshError::HostKeyError(format!(
        "The host key of {host}:{port} changed. Pinned {} ({}), presented {} ({}). Someone may be \
         intercepting the connection. If the host was reinstalled or its key rotated, choose \
         Forget host key in the connection's menu.",
        pinned.fingerprint, pinned.key_type, presented.fingerprint, presented.key_type
    ))
}

pub fn load_host_key(conn: &Connection, host: &str, port: u16) -> Result<Option<HostKey>, String> {
    conn.query_row(
        "SELECT key_type, fingerprint FROM known_hosts WHERE host = ? AND port = ?",
        rusqlite::params![host, port],
        |row| {
            Ok(HostKey {
                key_type: row.get(0)?,
                fingerprint: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("Failed to read the host key of {host}:{port}: {e}"))
}

/// Never overwrites an existing pin: replacing one goes through `forget_host_key`.
pub fn store_host_key(
    conn: &Connection,
    host: &str,
    port: u16,
    key: &HostKey,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO known_hosts (host, port, key_type, fingerprint, first_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(host, port) DO NOTHING",
        rusqlite::params![
            host,
            port,
            key.key_type,
            key.fingerprint,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("Failed to store the host key of {host}:{port}: {e}"))?;
    Ok(())
}

pub fn forget_host_key(conn: &Connection, host: &str, port: u16) -> Result<(), String> {
    conn.execute(
        "DELETE FROM known_hosts WHERE host = ? AND port = ?",
        rusqlite::params![host, port],
    )
    .map_err(|e| format!("Failed to forget the host key of {host}:{port}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(fingerprint: &str) -> HostKey {
        HostKey {
            key_type: "ssh-ed25519".to_string(),
            fingerprint: fingerprint.to_string(),
        }
    }

    #[test]
    fn accepts_any_key_without_a_pin_and_only_the_pinned_one_with() {
        assert!(accepts(None, &key("SHA256:a")));
        assert!(accepts(Some(&key("SHA256:a")), &key("SHA256:a")));
        assert!(!accepts(Some(&key("SHA256:a")), &key("SHA256:b")));
    }

    #[test]
    fn mismatch_error_names_the_host_and_both_fingerprints() {
        let SshError::HostKeyError(message) =
            mismatch_error("example.com", 2222, &key("SHA256:a"), &key("SHA256:b"))
        else {
            panic!("expected a HostKeyError");
        };
        assert!(message.contains("example.com:2222"));
        assert!(message.contains("SHA256:a"));
        assert!(message.contains("SHA256:b"));
        assert!(message.contains("Forget host key"));
    }

    #[test]
    fn from_presented_fingerprints_the_key_as_openssh_does() {
        let public_key = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAILagOJFgwaMNhBWQINinKOXmqS4Gh5NgxgriXwdOoINJ",
        )
        .unwrap();
        let presented = PublicKeyOrCertificate::PublicKey {
            key: public_key,
            hash_alg: None,
        };
        assert_eq!(
            HostKey::from_presented(&presented),
            key("SHA256:ldyiXa1JQakitNU5tErauu8DvWQ1dZ7aXu+rm7KQuog")
        );
    }

    #[test]
    fn store_load_and_forget() {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::schema::initialize_schema(&conn).unwrap();

        assert_eq!(load_host_key(&conn, "example.com", 22).unwrap(), None);

        store_host_key(&conn, "example.com", 22, &key("SHA256:a")).unwrap();
        store_host_key(&conn, "example.com", 22, &key("SHA256:a")).unwrap();
        store_host_key(&conn, "example.com", 22, &key("SHA256:b")).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM known_hosts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(
            load_host_key(&conn, "example.com", 22).unwrap(),
            Some(key("SHA256:a"))
        );
        assert_eq!(load_host_key(&conn, "example.com", 2222).unwrap(), None);

        forget_host_key(&conn, "example.com", 22).unwrap();
        assert_eq!(load_host_key(&conn, "example.com", 22).unwrap(), None);
    }
}
