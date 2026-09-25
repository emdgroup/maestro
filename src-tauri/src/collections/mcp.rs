//! MCP servers in Collections: the app's half.
//!
//! The list lives with the daemon of each connection (`maestro-server/src/mcp_store.rs`), because
//! that is the machine the agents run on and headless automations need it with no window open.
//! What stays here is what must not leave this machine at rest: secret values, kept in the OS
//! keychain under `maestro.mcp` / `<connection>:<server>:<key>` and pushed to the daemon's memory
//! with `SetMcpSecrets` after every preflight and every change.
//!
//! The catalog is the GitHub MCP Registry, fetched here rather than in the webview so every
//! catalog shares one client and one place that knows the registry's shape.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::State;

use crate::acp::connection_server::{
    query_list_mcp_servers_via_server, query_save_mcp_servers_via_server,
    query_set_mcp_secrets_via_server, query_test_mcp_server_via_server,
};
use crate::acp::ConnectionKey;
use crate::core::AppState;
use crate::integration::keychain::KeychainStore;

const KEYCHAIN_SERVICE: &str = "maestro.mcp";
const REGISTRY_URL: &str = "https://api.mcp.github.com/v0.1/servers";

/// One environment variable or header. A secret's `value` is `""` when read back; sending `""`
/// for a secret on save keeps what the keychain already holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpKeyValue {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

/// An MCP server the user manages, as the editor and the cards see it. Same shape as
/// `maestro_protocol::ManagedMcpServer`, which cannot derive `Type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpServerConfig {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<McpKeyValue>,
    pub url: Option<String>,
    pub headers: Vec<McpKeyValue>,
    /// Maestro agent ids the server is injected for.
    pub agents: Vec<String>,
    pub catalog_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct McpTestResult {
    pub ok: bool,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub stars: Option<u32>,
    pub repo_url: Option<String>,
    /// What the editor opens prefilled with. Required values the user has to supply are left
    /// blank, or as the registry's `{placeholder}`.
    pub install: McpServerConfig,
    /// Every package identifier and remote URL the entry offers, so a server installed some other
    /// way can still be recognised as this one.
    pub packages: Vec<String>,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct McpCatalogPage {
    pub entries: Vec<McpCatalogEntry>,
    pub next_cursor: Option<String>,
}

/// Same field names on both sides, so a JSON round trip is the whole conversion.
fn convert<A: Serialize, B: serde::de::DeserializeOwned>(value: A) -> Result<B, String> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|e| format!("Failed to convert the MCP server: {e}"))
}

fn account(connection: ConnectionKey, server: &str, key: &str) -> String {
    format!("{}:{server}:{key}", connection.storage_id())
}

fn secret_pairs(server: &McpServerConfig) -> impl Iterator<Item = &McpKeyValue> {
    server
        .env
        .iter()
        .chain(server.headers.iter())
        .filter(|pair| pair.secret)
}

async fn list(
    app_state: &Arc<AppState>,
    connection: ConnectionKey,
) -> Result<Vec<McpServerConfig>, String> {
    convert(
        query_list_mcp_servers_via_server(connection, None, app_state)
            .await?
            .servers,
    )
}

/// The managed servers, and the ones the project's own `.mcp.json` declares.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct McpServerList {
    pub servers: Vec<McpServerConfig>,
    /// From `.mcp.json`, sent to every agent and not edited here.
    pub project: Vec<McpServerConfig>,
}

/// Hand the daemon every secret its servers name. Best effort per value: one the keychain lost
/// is simply not sent, and the daemon skips that server with a reason in the log.
pub(crate) async fn push_secrets(
    app_state: &Arc<AppState>,
    connection: ConnectionKey,
) -> Result<(), String> {
    let servers = list(app_state, connection).await?;
    let mut secrets = Vec::new();
    for server in &servers {
        for pair in secret_pairs(server) {
            let account = account(connection, &server.name, &pair.key);
            match KeychainStore::get_secret(KEYCHAIN_SERVICE, &account, &app_state.app_data_dir) {
                Ok(Some(value)) => secrets.push(maestro_protocol::McpSecret {
                    server: server.name.clone(),
                    key: pair.key.clone(),
                    value,
                }),
                Ok(None) => log::warn!("[mcp] no stored value for {account}"),
                Err(e) => log::warn!("[mcp] reading {account} from the keychain failed: {e}"),
            }
        }
    }
    query_set_mcp_secrets_via_server(connection, secrets, app_state).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_mcp_servers(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    project_path: Option<String>,
) -> Result<McpServerList, String> {
    let listed = query_list_mcp_servers_via_server(connection, project_path, &app_state).await?;
    Ok(McpServerList {
        servers: convert(listed.servers)?,
        project: convert(listed.project)?,
    })
}

/// Create a server, or replace the one called `previous_name` (the same name when not renamed).
#[tauri::command]
#[specta::specta]
pub async fn save_mcp_server(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    server: McpServerConfig,
    previous_name: Option<String>,
) -> Result<(), String> {
    let mut servers = list(&app_state, connection).await?;
    let previous = previous_name.unwrap_or_else(|| server.name.clone());
    let old = servers.iter().position(|s| s.name == previous);
    if servers
        .iter()
        .enumerate()
        .any(|(i, s)| s.name == server.name && Some(i) != old)
    {
        return Err(format!(
            "An MCP server named \"{}\" already exists",
            server.name
        ));
    }

    let dir = &app_state.app_data_dir;
    // A secret left blank with nothing stored is an optional one the user skipped. Kept, it would
    // hold the server back forever waiting for a value that is never coming.
    let mut server = server;
    let unset = |pair: &McpKeyValue| {
        pair.key.trim().is_empty()
            || (pair.secret
                && pair.value.is_empty()
                && KeychainStore::get_secret(
                    KEYCHAIN_SERVICE,
                    &account(connection, &previous, &pair.key),
                    dir,
                )
                .ok()
                .flatten()
                .is_none())
    };
    server.env.retain(|pair| !unset(pair));
    server.headers.retain(|pair| !unset(pair));
    for pair in secret_pairs(&server) {
        let target = account(connection, &server.name, &pair.key);
        if !pair.value.is_empty() {
            KeychainStore::set_secret(KEYCHAIN_SERVICE, &target, &pair.value, dir)?;
        } else if previous != server.name {
            // Renamed with the value left untouched: carry it over to the new name.
            let from = account(connection, &previous, &pair.key);
            if let Some(value) = KeychainStore::get_secret(KEYCHAIN_SERVICE, &from, dir)? {
                KeychainStore::set_secret(KEYCHAIN_SERVICE, &target, &value, dir)?;
            }
        }
    }
    // Forget the values this server no longer names, under its old name as well as its new one.
    if let Some(i) = old {
        for pair in secret_pairs(&servers[i]) {
            let kept = server.name == previous
                && secret_pairs(&server).any(|kept_pair| kept_pair.key == pair.key);
            if !kept {
                let stale = account(connection, &previous, &pair.key);
                KeychainStore::delete_secret(KEYCHAIN_SERVICE, &stale, dir)?;
            }
        }
    }

    let mut stored = server;
    for pair in stored.env.iter_mut().chain(stored.headers.iter_mut()) {
        if pair.secret {
            pair.value.clear();
        }
    }
    match old {
        Some(i) => servers[i] = stored,
        None => servers.push(stored),
    }
    query_save_mcp_servers_via_server(connection, convert(servers)?, &app_state).await?;
    push_secrets(&app_state, connection).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_mcp_server(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    name: String,
) -> Result<(), String> {
    let mut servers = list(&app_state, connection).await?;
    if let Some(i) = servers.iter().position(|s| s.name == name) {
        let removed = servers.remove(i);
        for pair in secret_pairs(&removed) {
            let account = account(connection, &name, &pair.key);
            KeychainStore::delete_secret(KEYCHAIN_SERVICE, &account, &app_state.app_data_dir)?;
        }
    }
    query_save_mcp_servers_via_server(connection, convert(servers)?, &app_state).await?;
    push_secrets(&app_state, connection).await
}

/// Connect to a server from the connection's machine, where the agents run, and list its tools.
#[tauri::command]
#[specta::specta]
pub async fn test_mcp_server(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    server: McpServerConfig,
    previous_name: Option<String>,
) -> Result<McpTestResult, String> {
    let mut server = server;
    let stored_under = previous_name.unwrap_or_else(|| server.name.clone());
    for pair in server.env.iter_mut().chain(server.headers.iter_mut()) {
        if pair.secret && pair.value.is_empty() {
            let account = account(connection, &stored_under, &pair.key);
            if let Some(value) =
                KeychainStore::get_secret(KEYCHAIN_SERVICE, &account, &app_state.app_data_dir)?
            {
                pair.value = value;
            }
        }
    }
    convert(query_test_mcp_server_via_server(connection, convert(server)?, &app_state).await?)
}

/// A page of the GitHub MCP Registry: its curated, star-ranked list with no query, a search with
/// one. Each entry carries the server the editor should open with.
#[tauri::command]
#[specta::specta]
pub async fn mcp_catalog(
    query: Option<String>,
    cursor: Option<String>,
) -> Result<McpCatalogPage, String> {
    let mut url = format!("{REGISTRY_URL}?limit=50");
    if let Some(query) = query.filter(|query| !query.trim().is_empty()) {
        url.push_str(&format!("&search={}", urlencoding::encode(query.trim())));
    }
    if let Some(cursor) = cursor {
        url.push_str(&format!("&cursor={}", urlencoding::encode(&cursor)));
    }
    let page: Value = crate::integration::providers::http_client()?
        .get(&url)
        .header("User-Agent", "maestro")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("The MCP registry could not be reached: {e}"))?
        .json()
        .await
        .map_err(|e| format!("The MCP registry sent something unexpected: {e}"))?;
    Ok(McpCatalogPage {
        entries: page
            .get("servers")
            .and_then(Value::as_array)
            .map(|servers| servers.iter().filter_map(catalog_entry).collect())
            .unwrap_or_default(),
        next_cursor: page
            .pointer("/metadata/nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// One registry entry, or `None` when it offers nothing Maestro can run.
fn catalog_entry(entry: &Value) -> Option<McpCatalogEntry> {
    let server = entry.get("server")?;
    let id = text(server, "name")?;
    let github = server
        .get("_meta")
        .and_then(|m| m.get("io.modelcontextprotocol.registry/publisher-provided"))
        .and_then(|m| m.get("github"));
    let name = github
        .and_then(|g| text(g, "displayName"))
        .or_else(|| text(server, "title"))
        .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(&id).to_string());
    let install = install_config(server, &name)?;
    Some(McpCatalogEntry {
        description: text(server, "description").unwrap_or_default(),
        icon_url: github.and_then(|g| text(g, "ownerAvatarUrl")).or_else(|| {
            server
                .pointer("/icons/0/src")
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        stars: github
            .and_then(|g| g.get("stargazerCount"))
            .and_then(Value::as_u64)
            .map(|n| n as u32),
        repo_url: server
            .pointer("/repository/url")
            .and_then(Value::as_str)
            .map(str::to_string),
        install: McpServerConfig {
            catalog_id: Some(id.clone()),
            ..install
        },
        packages: listed(server, "packages", "identifier"),
        urls: listed(server, "remotes", "url"),
        id,
        name,
    })
}

/// `field` of every item in the array `key`.
fn listed(server: &Value, key: &str, field: &str) -> Vec<String> {
    server
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| text(item, field)).collect())
        .unwrap_or_default()
}

/// A config name the editor accepts as typed: lower case, no spaces.
fn slug(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug.split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// A local package first, since it needs no account; a remote when that is all there is.
fn install_config(server: &Value, name: &str) -> Option<McpServerConfig> {
    let base = McpServerConfig {
        name: slug(name),
        transport: "stdio".to_string(),
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
        agents: Vec::new(),
        catalog_id: None,
    };
    let packages = server.get("packages").and_then(Value::as_array);
    if let Some(config) = packages
        .into_iter()
        .flatten()
        .find_map(|p| package_config(p, base.clone()))
    {
        return Some(config);
    }
    let remote = server
        .get("remotes")
        .and_then(Value::as_array)?
        .iter()
        .find(|r| {
            matches!(
                r.get("type").and_then(Value::as_str),
                Some("streamable-http" | "sse")
            )
        })?;
    Some(McpServerConfig {
        transport: if remote.get("type")?.as_str()? == "sse" {
            "sse"
        } else {
            "http"
        }
        .to_string(),
        url: text(remote, "url"),
        headers: pairs(remote.get("headers")),
        ..base
    })
}

fn package_config(package: &Value, base: McpServerConfig) -> Option<McpServerConfig> {
    if package.pointer("/transport/type").and_then(Value::as_str) != Some("stdio") {
        return None;
    }
    let identifier = text(package, "identifier")?;
    let version = text(package, "version").filter(|v| v != "latest");
    let runtime = arguments(package.get("runtimeArguments"));
    let (command, mut args, spec) = match package.get("registryType")?.as_str()? {
        "npm" => (
            "npx",
            vec!["-y".to_string()],
            match version {
                Some(v) => format!("{identifier}@{v}"),
                None => identifier.clone(),
            },
        ),
        "pypi" => (
            "uvx",
            Vec::new(),
            match version {
                Some(v) => format!("{identifier}=={v}"),
                None => identifier.clone(),
            },
        ),
        "oci" => (
            "docker",
            vec!["run".to_string(), "-i".to_string(), "--rm".to_string()],
            identifier.clone(),
        ),
        _ => return None,
    };
    let command = text(package, "runtimeHint").unwrap_or_else(|| command.to_string());
    // Some entries already name the package among their runtime arguments (`uvx --from ... pkg`).
    let names_itself = runtime.contains(&identifier);
    args.extend(runtime);
    if !names_itself {
        args.push(spec);
    }
    args.extend(arguments(package.get("packageArguments")));
    Some(McpServerConfig {
        command: Some(command),
        args,
        env: package
            .get("environmentVariables")
            .and_then(Value::as_array)
            .map(|vars| {
                vars.iter()
                    .filter_map(|v| {
                        Some(McpKeyValue {
                            key: text(v, "name")?,
                            value: text(v, "default").unwrap_or_default(),
                            secret: v.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        ..base
    })
}

/// Registry arguments as a command line: `named` ones are the flag then its value, `positional`
/// ones are the value, or `<hint>` for one the user has to fill in.
fn arguments(list: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    for arg in list.and_then(Value::as_array).into_iter().flatten() {
        let value = text(arg, "value");
        match arg.get("type").and_then(Value::as_str) {
            Some("named") => {
                if let Some(name) = text(arg, "name") {
                    out.push(name);
                }
                out.extend(value);
            }
            _ => {
                out.extend(value.or_else(|| text(arg, "valueHint").map(|hint| format!("<{hint}>"))))
            }
        }
    }
    out
}

fn pairs(list: Option<&Value>) -> Vec<McpKeyValue> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|h| {
                    Some(McpKeyValue {
                        key: text(h, "name")?,
                        value: text(h, "value").unwrap_or_default(),
                        secret: h.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap(server: Value) -> Value {
        json!({ "server": server })
    }

    #[test]
    fn npm_packages_run_through_npx_with_their_env() {
        let entry = catalog_entry(&wrap(json!({
            "name": "io.github.upstash/context7",
            "title": "Context7",
            "description": "Up-to-date code docs",
            "packages": [{
                "identifier": "@upstash/context7-mcp", "registryType": "npm", "version": "4.1.1",
                "transport": { "type": "stdio" },
                "environmentVariables": [{ "name": "CONTEXT7_API_KEY", "isSecret": true }]
            }],
            "remotes": [{ "type": "streamable-http", "url": "https://mcp.context7.com/mcp" }],
            "_meta": { "io.modelcontextprotocol.registry/publisher-provided": { "github": {
                "displayName": "Context7", "stargazerCount": 62398,
                "ownerAvatarUrl": "https://avatars.example/u/1"
            }}}
        })))
        .expect("entry");
        assert_eq!(entry.name, "Context7");
        assert_eq!(entry.stars, Some(62398));
        assert_eq!(
            entry.icon_url.as_deref(),
            Some("https://avatars.example/u/1")
        );
        assert_eq!(entry.packages, vec!["@upstash/context7-mcp"]);
        assert_eq!(entry.urls, vec!["https://mcp.context7.com/mcp"]);
        let install = entry.install;
        assert_eq!(install.name, "context7");
        assert_eq!(install.command.as_deref(), Some("npx"));
        assert_eq!(install.args, vec!["-y", "@upstash/context7-mcp@4.1.1"]);
        assert_eq!(install.env[0].key, "CONTEXT7_API_KEY");
        assert!(install.env[0].secret);
        assert_eq!(
            install.catalog_id.as_deref(),
            Some("io.github.upstash/context7")
        );
    }

    #[test]
    fn pypi_packages_run_through_uvx_and_are_not_named_twice() {
        let entry = catalog_entry(&wrap(json!({
            "name": "oraios/serena",
            "packages": [{
                "identifier": "serena", "registryType": "pypi", "runtimeHint": "uvx",
                "version": "latest", "transport": { "type": "stdio" },
                "runtimeArguments": [
                    { "type": "named", "name": "--from" },
                    { "type": "positional", "value": "git+https://github.com/oraios/serena" },
                    { "type": "positional", "value": "serena" },
                    { "type": "positional", "value": "start-mcp-server" }
                ],
                "packageArguments": [
                    { "type": "named", "name": "--context" },
                    { "type": "positional", "value": "ide-assistant" }
                ]
            }]
        })))
        .expect("entry");
        assert_eq!(entry.install.command.as_deref(), Some("uvx"));
        assert_eq!(
            entry.install.args,
            vec![
                "--from",
                "git+https://github.com/oraios/serena",
                "serena",
                "start-mcp-server",
                "--context",
                "ide-assistant"
            ]
        );
        let plain = catalog_entry(&wrap(json!({
            "name": "microsoft/markitdown",
            "packages": [{ "identifier": "markitdown-mcp", "registryType": "pypi",
                "version": "0.0.1a4", "transport": { "type": "stdio" } }]
        })))
        .expect("entry");
        assert_eq!(plain.install.args, vec!["markitdown-mcp==0.0.1a4"]);
    }

    #[test]
    fn oci_packages_run_through_docker() {
        let entry = catalog_entry(&wrap(json!({
            "name": "io.github.github/github-mcp-server",
            "packages": [{
                "identifier": "ghcr.io/github/github-mcp-server:1.12.2", "registryType": "oci",
                "transport": { "type": "stdio" },
                "runtimeArguments": [{ "type": "named", "name": "-e",
                    "value": "GITHUB_PERSONAL_ACCESS_TOKEN={token}" }]
            }]
        })))
        .expect("entry");
        assert_eq!(entry.install.command.as_deref(), Some("docker"));
        assert_eq!(
            entry.install.args,
            vec![
                "run",
                "-i",
                "--rm",
                "-e",
                "GITHUB_PERSONAL_ACCESS_TOKEN={token}",
                "ghcr.io/github/github-mcp-server:1.12.2"
            ]
        );
    }

    #[test]
    fn a_remote_only_entry_becomes_an_http_server_with_its_headers() {
        let entry = catalog_entry(&wrap(json!({
            "name": "io.github.netdata/mcp-server",
            "title": "Netdata",
            "remotes": [{
                "type": "streamable-http", "url": "https://app.netdata.cloud/api/v1/mcp",
                "headers": [{ "name": "Authorization", "isSecret": true,
                    "value": "Bearer {NETDATA_CLOUD_API_TOKEN}" }]
            }]
        })))
        .expect("entry");
        assert_eq!(entry.install.transport, "http");
        assert_eq!(
            entry.install.url.as_deref(),
            Some("https://app.netdata.cloud/api/v1/mcp")
        );
        assert_eq!(entry.install.headers[0].key, "Authorization");
        assert!(entry.install.headers[0].secret);
    }

    #[test]
    fn an_entry_with_nothing_runnable_is_left_out() {
        assert!(catalog_entry(&wrap(json!({
            "name": "x/y",
            "packages": [{ "identifier": "x.mcpb", "registryType": "mcpb",
                "transport": { "type": "stdio" } }]
        })))
        .is_none());
    }
}
