//! MCP servers the user manages from Collections, for every session on this machine.
//!
//! Stored in `~/.maestro/mcp-servers.json`, beside `tools.json` and `custom-agents.json`, and
//! appended by `mcp_servers_for` after the project's own `.mcp.json` for the agents each one
//! lists. Secret values are never in the file: the app keeps them in the OS keychain and pushes
//! them with `SetMcpSecrets` after every preflight and save, so they live in `SECRETS` for this
//! process only. A server whose secret has not arrived is skipped rather than started with a
//! blank token.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use acp::schema::v1::McpServer;
use agent_client_protocol as acp;
use maestro_protocol::{ManagedMcpServer, McpKeyValue, McpSecret, McpTestResult};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::mcp_config::{convert_entry, LoadedMcpServers, McpJsonEntry, McpTransportSupport};

type Secrets = HashMap<(String, String), String>;

/// `(server, key)` to value.
static SECRETS: LazyLock<Mutex<Secrets>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    servers: Vec<ManagedMcpServer>,
}

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::tool_config::home_dir()?
        .join(".maestro")
        .join("mcp-servers.json"))
}

pub(crate) fn list() -> Result<Vec<ManagedMcpServer>, String> {
    read_from(&store_path()?)
}

fn read_from(path: &Path) -> Result<Vec<ManagedMcpServer>, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str::<StoreFile>(&contents)
            .map(|file| file.servers)
            .map_err(|error| format!("Invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub(crate) fn save(servers: Vec<ManagedMcpServer>) -> Result<(), String> {
    write_to(&store_path()?, servers)
}

fn write_to(path: &Path, mut servers: Vec<ManagedMcpServer>) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for server in &mut servers {
        if server.name.trim().is_empty() {
            return Err("An MCP server needs a name".to_string());
        }
        if server.name == maestro_protocol::MCP_SERVER_NAME {
            return Err(format!(
                "\"{}\" is reserved for Maestro's own server",
                server.name
            ));
        }
        if !names.insert(server.name.clone()) {
            return Err(format!("Two MCP servers are named \"{}\"", server.name));
        }
        // Belt and braces: the app already sends these blank.
        for kv in server.env.iter_mut().chain(server.headers.iter_mut()) {
            if kv.secret {
                kv.value.clear();
            }
        }
    }
    write_json_atomic(
        path,
        &StoreFile {
            version: 1,
            servers,
        },
    )
}

/// Write through a temporary file and a rename, so a crash never leaves half a file.
///
/// ponytail: no file lock, because one daemon per machine is the only writer (its own lock says
/// so). Add one if anything else ever writes these files.
pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure {}: {error}", temporary.display()))?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

/// Replace every secret held for the managed servers.
pub(crate) fn set_secrets(secrets: Vec<McpSecret>) {
    let map = secrets
        .into_iter()
        .map(|s| ((s.server, s.key), s.value))
        .collect();
    if let Ok(mut guard) = SECRETS.lock() {
        *guard = map;
    }
}

/// The managed servers that list `agent_id`, converted for ACP. `taken` holds the names the
/// project's `.mcp.json` already sent: the project wins a collision, since it is the more specific
/// of the two.
pub(crate) fn servers_for(
    agent_id: &str,
    support: McpTransportSupport,
    taken: &BTreeSet<String>,
) -> LoadedMcpServers {
    let servers = match list() {
        Ok(servers) => servers,
        Err(e) => {
            return LoadedMcpServers {
                servers: Vec::new(),
                skipped: vec![e],
            }
        }
    };
    let secrets = SECRETS.lock().map(|g| g.clone()).unwrap_or_default();
    convert_for(
        servers,
        agent_id,
        support,
        taken,
        &secrets,
        &std::env::vars().collect(),
    )
}

fn convert_for(
    servers: Vec<ManagedMcpServer>,
    agent_id: &str,
    support: McpTransportSupport,
    taken: &BTreeSet<String>,
    secrets: &Secrets,
    env: &BTreeMap<String, String>,
) -> LoadedMcpServers {
    let mut out = LoadedMcpServers::default();
    for server in servers {
        if !server.agents.iter().any(|a| a == agent_id) {
            continue;
        }
        let name = server.name.clone();
        if name == maestro_protocol::MCP_SERVER_NAME {
            out.skipped.push(format!(
                "{name}: reserved — Maestro provides its own server under this name"
            ));
            continue;
        }
        if taken.contains(&name) {
            out.skipped.push(format!(
                "{name}: the project's {} defines a server by this name, and it wins",
                crate::mcp_config::MCP_CONFIG_FILE
            ));
            continue;
        }
        match to_entry(&server, secrets).and_then(|e| convert_entry(&name, e, support, env)) {
            Ok(converted) => out.servers.push(converted),
            Err(reason) => out.skipped.push(format!("{name}: {reason}")),
        }
    }
    out
}

/// The `.mcp.json` shape of a managed server, with secret values filled in from `secrets`.
fn to_entry(server: &ManagedMcpServer, secrets: &Secrets) -> Result<McpJsonEntry, String> {
    let fill = |pairs: &[McpKeyValue]| -> Result<BTreeMap<String, String>, String> {
        pairs
            .iter()
            .map(|kv| {
                if !kv.secret {
                    return Ok((kv.key.clone(), kv.value.clone()));
                }
                secrets
                    .get(&(server.name.clone(), kv.key.clone()))
                    .map(|v| (kv.key.clone(), v.clone()))
                    .ok_or_else(|| {
                        format!(
                            "secret {} has not reached this server yet; reopen the project",
                            kv.key
                        )
                    })
            })
            .collect()
    };
    Ok(McpJsonEntry {
        transport: Some(server.transport.clone()),
        command: server.command.clone(),
        args: server.args.clone(),
        env: fill(&server.env)?,
        url: server.url.clone(),
        headers: fill(&server.headers)?,
    })
}

/// Connect to a server and ask for its tools. `server` carries its secret values.
///
/// Run here rather than in the app so the answer is about this machine: a stdio command has to
/// exist here, and a URL has to be reachable from here, since this is where the agents run.
pub(crate) async fn test(server: ManagedMcpServer) -> McpTestResult {
    match tokio::time::timeout(TEST_TIMEOUT, probe(server)).await {
        Ok(Ok(tools)) => McpTestResult {
            ok: true,
            tools,
            error: None,
        },
        Ok(Err(error)) => McpTestResult {
            ok: false,
            tools: Vec::new(),
            error: Some(error),
        },
        Err(_) => McpTestResult {
            ok: false,
            tools: Vec::new(),
            error: Some(format!("No answer within {TEST_TIMEOUT:?}")),
        },
    }
}

async fn probe(server: ManagedMcpServer) -> Result<Vec<String>, String> {
    // The request carries the values themselves, so they are the whole secret map.
    let secrets: Secrets = server
        .env
        .iter()
        .chain(server.headers.iter())
        .filter(|kv| kv.secret)
        .map(|kv| ((server.name.clone(), kv.key.clone()), kv.value.clone()))
        .collect();
    let entry = to_entry(&server, &secrets)?;
    let every_transport = McpTransportSupport {
        http: true,
        sse: true,
    };
    match convert_entry(
        &server.name,
        entry,
        every_transport,
        &std::env::vars().collect(),
    )? {
        McpServer::Stdio(stdio) => probe_stdio(stdio).await,
        McpServer::Http(http) => probe_http(&http.url, &http.headers).await,
        McpServer::Sse(sse) => probe_sse(&sse.url, &sse.headers).await,
        _ => Err("This transport cannot be tested".to_string()),
    }
}

async fn probe_stdio(stdio: acp::schema::v1::McpServerStdio) -> Result<Vec<String>, String> {
    let env: HashMap<String, String> = stdio.env.into_iter().map(|v| (v.name, v.value)).collect();
    let home = crate::tool_config::home_dir()?;
    // ponytail: `kill_on_drop` stops the direct child only; a launcher such as `npx` can leave its
    // node child behind until it notices stdin closed. A process-group kill fixes that if it bites.
    let mut child = crate::agent::spawn_agent_subprocess(
        &stdio.command.to_string_lossy(),
        &stdio.args,
        &home.to_string_lossy(),
        &env,
    )
    .await?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(16 * 1024).read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let result = async {
        send(&mut stdin, initialize_request()).await?;
        answer(&mut lines, 1).await?;
        send(
            &mut stdin,
            serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )
        .await?;
        send(
            &mut stdin,
            serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await?;
        let listed = answer(&mut lines, 2).await?;
        Ok::<_, String>(tool_names(&listed))
    }
    .await;

    let _ = child.kill().await;
    match result {
        Ok(tools) => Ok(tools),
        Err(error) => {
            let stderr = tokio::time::timeout(std::time::Duration::from_secs(1), stderr_task)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            match stderr.trim().lines().last() {
                Some(last) => Err(format!("{error}: {last}")),
                None => Err(error),
            }
        }
    }
}

async fn send(
    stdin: &mut tokio::process::ChildStdin,
    message: serde_json::Value,
) -> Result<(), String> {
    let mut line = message.to_string();
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("The server closed its input: {e}"))
}

/// Read until the response to `id`, skipping logs and notifications a server may print first.
async fn answer(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<serde_json::Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| format!("Reading the server failed: {e}"))?
            .ok_or("The server exited before answering")?;
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("The server answered with an error")
                .to_string());
        }
        return Ok(message.get("result").cloned().unwrap_or_default());
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build an HTTP client: {e}"))
}

fn with_headers(
    mut request: reqwest::RequestBuilder,
    headers: &[acp::schema::v1::HttpHeader],
) -> reqwest::RequestBuilder {
    for header in headers {
        request = request.header(&header.name, &header.value);
    }
    request
}

/// ponytail: an sse server is only checked for an event stream; listing its tools needs the
/// endpoint handshake the legacy transport requires. Speak it if sse servers stay common.
async fn probe_sse(
    url: &str,
    headers: &[acp::schema::v1::HttpHeader],
) -> Result<Vec<String>, String> {
    let response = with_headers(http_client()?.get(url), headers)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    if response.status().is_success() {
        Ok(Vec::new())
    } else {
        Err(format!("{url} answered {}", response.status()))
    }
}

/// Streamable HTTP: `initialize`, then `tools/list` on the session the server hands back.
async fn probe_http(
    url: &str,
    headers: &[acp::schema::v1::HttpHeader],
) -> Result<Vec<String>, String> {
    let client = http_client()?;
    let post = |body: serde_json::Value, session: Option<String>| {
        let mut request = with_headers(client.post(url), headers)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(body.to_string());
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        request.send()
    };
    let initialize = post(initialize_request(), None)
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    let session = initialize
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    rpc_result(initialize, 1).await?;
    // A notification has no answer to wait for; a server that refuses it will refuse the listing
    // too, and that is the error worth reporting.
    if let Err(e) = post(
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        session.clone(),
    )
    .await
    {
        crate::send_diag(
            "debug",
            format!("[mcp] notifications/initialized to {url}: {e}"),
        );
    }
    let listed = post(
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        session,
    )
    .await
    .map_err(|e| format!("Could not reach {url}: {e}"))?;
    Ok(tool_names(&rpc_result(listed, 2).await?))
}

fn initialize_request() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "maestro", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// The result of JSON-RPC call `id`, answered either as JSON or as an event stream.
async fn rpc_result(mut response: reqwest::Response, id: u64) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => format!("{status}: check the credentials"),
            _ => format!("The server answered {status}"),
        });
    }
    // Read in chunks rather than to the end: an event stream may stay open after the answer.
    let mut body = String::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Reading the answer failed: {e}"))?
    {
        body.push_str(&String::from_utf8_lossy(&chunk));
        if let Some(found) = find_response(&body, id) {
            return found;
        }
    }
    find_response(&body, id).unwrap_or_else(|| Err("The server sent no answer".to_string()))
}

/// Look for the response to `id` in a JSON body or in the `data:` lines of an event stream.
fn find_response(body: &str, id: u64) -> Option<Result<serde_json::Value, String>> {
    let candidates = std::iter::once(body.trim()).chain(
        body.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim),
    );
    candidates
        .filter_map(|candidate| serde_json::from_str::<serde_json::Value>(candidate).ok())
        .find(|message| message.get("id").and_then(serde_json::Value::as_u64) == Some(id))
        .map(|message| match message.get("error") {
            Some(error) => Err(error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("The server answered with an error")
                .to_string()),
            None => Ok(message.get("result").cloned().unwrap_or_default()),
        })
}

fn tool_names(result: &serde_json::Value) -> Vec<String> {
    result
        .get("tools")
        .and_then(serde_json::Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t.get("name")?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(key: &str, value: &str, secret: bool) -> McpKeyValue {
        McpKeyValue {
            key: key.to_string(),
            value: value.to_string(),
            secret,
        }
    }

    fn stdio(name: &str, agents: &[&str]) -> ManagedMcpServer {
        ManagedMcpServer {
            name: name.to_string(),
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "pkg".to_string()],
            env: vec![kv("PLAIN", "1", false), kv("TOKEN", "", true)],
            url: None,
            headers: Vec::new(),
            agents: agents.iter().map(|a| a.to_string()).collect(),
            catalog_id: None,
        }
    }

    fn names(loaded: &LoadedMcpServers) -> Vec<String> {
        loaded
            .servers
            .iter()
            .map(|s| match s {
                McpServer::Stdio(s) => s.name.clone(),
                McpServer::Http(s) => s.name.clone(),
                McpServer::Sse(s) => s.name.clone(),
                _ => String::new(),
            })
            .collect()
    }

    fn secret(server: &str) -> Secrets {
        [((server.to_string(), "TOKEN".to_string()), "t0k".to_string())].into()
    }

    #[test]
    fn store_round_trips_with_secrets_blanked() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("mcp-servers.json");
        let mut server = stdio("ctx", &["claude-acp"]);
        server.env[1].value = "leaked".to_string();
        write_to(&path, vec![server]).expect("save");
        let read = read_from(&path).expect("read");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].env[0].value, "1");
        assert_eq!(read[0].env[1].value, "", "a secret never reaches the disk");
        assert!(!std::fs::read_to_string(&path).unwrap().contains("leaked"));
    }

    #[test]
    fn store_refuses_duplicate_and_reserved_names() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("mcp-servers.json");
        assert!(write_to(&path, vec![stdio("a", &[]), stdio("a", &[])]).is_err());
        assert!(write_to(&path, vec![stdio(maestro_protocol::MCP_SERVER_NAME, &[])]).is_err());
        assert!(read_from(&path).expect("missing is empty").is_empty());
    }

    #[test]
    fn only_servers_listing_the_agent_are_sent() {
        let loaded = convert_for(
            vec![
                stdio("ctx", &["claude-acp"]),
                stdio("other", &["codex-acp"]),
            ],
            "claude-acp",
            McpTransportSupport::default(),
            &BTreeSet::new(),
            &secret("ctx"),
            &BTreeMap::new(),
        );
        assert_eq!(names(&loaded), vec!["ctx"]);
        let McpServer::Stdio(s) = &loaded.servers[0] else {
            panic!("stdio")
        };
        assert!(s.env.iter().any(|e| e.name == "TOKEN" && e.value == "t0k"));
    }

    #[test]
    fn a_missing_secret_skips_the_server() {
        let loaded = convert_for(
            vec![stdio("ctx", &["claude-acp"])],
            "claude-acp",
            McpTransportSupport::default(),
            &BTreeSet::new(),
            &Secrets::new(),
            &BTreeMap::new(),
        );
        assert!(loaded.servers.is_empty());
        assert!(loaded.skipped[0].contains("TOKEN"), "{:?}", loaded.skipped);
    }

    #[test]
    fn the_project_mcp_json_wins_a_name_collision() {
        let loaded = convert_for(
            vec![stdio("ctx", &["claude-acp"])],
            "claude-acp",
            McpTransportSupport::default(),
            &["ctx".to_string()].into(),
            &secret("ctx"),
            &BTreeMap::new(),
        );
        assert!(loaded.servers.is_empty());
        assert!(loaded.skipped[0].contains(".mcp.json"));
    }

    #[test]
    fn responses_are_found_in_json_and_in_event_streams() {
        let json = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#;
        assert!(find_response(json, 2).expect("json").is_ok());
        let sse = "event: message
data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"nope\"}}

";
        assert_eq!(find_response(sse, 1), Some(Err("nope".to_string())));
        assert_eq!(find_response(sse, 2), None);
    }

    #[test]
    fn a_project_mcp_json_is_listed_as_written() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"docs":{"url":"https://x/mcp"},"maestro":{"command":"x"},"fs":{"command":"npx","args":["-y","fs"],"env":{"A":"${B}"}}}}"#,
        )
        .expect("write");
        let listed = crate::mcp_config::project_servers(&root.path().to_string_lossy());
        let names: Vec<_> = listed
            .iter()
            .map(|s| (s.name.as_str(), s.transport.as_str()))
            .collect();
        assert_eq!(names, vec![("docs", "http"), ("fs", "stdio")]);
        assert_eq!(listed[1].env[0].value, "${B}", "nothing is expanded");
    }

    #[test]
    fn http_is_gated_on_the_agent_capability() {
        let server = ManagedMcpServer {
            transport: "http".to_string(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            url: Some("https://example.com/mcp".to_string()),
            headers: vec![kv("Authorization", "", true)],
            ..stdio("remote", &["claude-acp"])
        };
        let secrets: Secrets = [(
            ("remote".to_string(), "Authorization".to_string()),
            "Bearer x".to_string(),
        )]
        .into();
        let refused = convert_for(
            vec![server.clone()],
            "claude-acp",
            McpTransportSupport::default(),
            &BTreeSet::new(),
            &secrets,
            &BTreeMap::new(),
        );
        assert!(refused.servers.is_empty());
        let sent = convert_for(
            vec![server],
            "claude-acp",
            McpTransportSupport {
                http: true,
                sse: false,
            },
            &BTreeSet::new(),
            &secrets,
            &BTreeMap::new(),
        );
        assert_eq!(names(&sent), vec!["remote"]);
    }
}
