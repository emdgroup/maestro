//! The `maestro mcp` subcommand: a per-session MCP server the agent spawns over stdio.
//!
//! It owns no state. Every `tools/call` opens one TCP connection to the gateway in the *running*
//! `maestro-server` (see `mcp_gateway`), sends a `GatewayRequest` and waits for the answer, so a
//! shim that the agent restarts mid-session costs nothing.
//!
//! Canvas arguments are not inspected beyond their shape: a surface is an HTML document, and the
//! frame reports what it could not load or run back to the host, so a validator here would only
//! guess earlier and be wrong about strings inside JavaScript.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;

use maestro_protocol::{
    read_frame, write_frame, GatewayRequest, HostToolCall, HostToolResult, MCP_GATEWAY_PORT_ENV,
    MCP_GATEWAY_SESSION_ENV, MCP_GATEWAY_TOKEN_ENV,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// The agent-facing tool surface. Vendored like the catalog and the agent registry — never
/// fetched, never generated — so what the agent is told is reviewable as a document.
const TOOLS_MANIFEST: &str = include_str!("assets/mcp-tools.json");

/// Versions of the MCP protocol this shim answers `initialize` with, when the client asked for
/// one of them. Anything else gets the newest — the client decides whether to keep talking.
const SUPPORTED_MCP_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_MCP_VERSION: &str = "2025-06-18";

/// Ceiling on one gateway round trip. Above the gateway's own 90 s, so its "host did not answer"
/// reaches the agent instead of being masked by a transport error here.
const GATEWAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

struct Shim {
    port: u16,
    token: String,
    session_id: String,
    next_request_id: AtomicU64,
}

pub(crate) fn run() -> i32 {
    let (port, token, session_id) = match read_env() {
        Ok(values) => values,
        Err(message) => {
            eprintln!("maestro mcp: {message}");
            return 1;
        }
    };
    let shim = Arc::new(Shim {
        port,
        token,
        session_id,
        next_request_id: AtomicU64::new(0),
    });
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("maestro mcp: cannot start runtime: {e}");
            return 1;
        }
    };
    runtime.block_on(serve(tokio::io::stdin(), tokio::io::stdout(), shim));
    0
}

fn read_env() -> Result<(u16, String, String), String> {
    let port = std::env::var(MCP_GATEWAY_PORT_ENV)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("{MCP_GATEWAY_PORT_ENV} is unset or not a port number"))?;
    let token = std::env::var(MCP_GATEWAY_TOKEN_ENV)
        .map_err(|_| format!("{MCP_GATEWAY_TOKEN_ENV} is unset"))?;
    let session_id = std::env::var(MCP_GATEWAY_SESSION_ENV)
        .map_err(|_| format!("{MCP_GATEWAY_SESSION_ENV} is unset"))?;
    Ok((port, token, session_id))
}

/// Read newline-delimited JSON-RPC from `reader`, answer on `writer`.
///
/// One task per request so a `canvas_await` that blocks for a minute does not stop the agent from
/// calling anything else in the meantime.
async fn serve<R, W>(reader: R, writer: W, shim: Arc<Shim>)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(Mutex::new(writer));
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(e) => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") },
                });
                write_line(&writer, &response).await;
                continue;
            }
        };
        let shim = Arc::clone(&shim);
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            if let Some(response) = handle(&shim, request).await {
                write_line(&writer, &response).await;
            }
        });
    }
}

async fn write_line<W: AsyncWrite + Unpin>(writer: &Arc<Mutex<W>>, value: &Value) {
    let Ok(mut bytes) = serde_json::to_vec(value) else {
        return;
    };
    bytes.push(b'\n');
    let mut guard = writer.lock().await;
    if guard.write_all(&bytes).await.is_ok() {
        let _ = guard.flush().await;
    }
}

/// Answer one JSON-RPC message. `None` for a notification, which takes no reply.
async fn handle(shim: &Shim, request: Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned();
    // A message with no `id` is a notification; the only one that matters is
    // `notifications/initialized`, and the rest are ignored by the same rule.
    let id = match id {
        Some(Value::Null) | None => return None,
        Some(id) => id,
    };

    let outcome = match method {
        "initialize" => Ok(initialize_result(&request)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(shim, request.get("params")).await,
        other => Err((-32601, format!("unknown method: {other}"))),
    };

    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    })
}

fn initialize_result(request: &Value) -> Value {
    let requested = request
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = if SUPPORTED_MCP_VERSIONS.contains(&requested) {
        requested
    } else {
        DEFAULT_MCP_VERSION
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "maestro", "version": env!("CARGO_PKG_VERSION") },
    })
}

async fn call_tool(shim: &Shim, params: Option<&Value>) -> Result<Value, (i64, String)> {
    let params = params.ok_or((-32602, "tools/call needs params".to_string()))?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "tools/call needs a tool name".to_string()))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    if !tools()
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
    {
        return Err((-32602, format!("unknown tool: {name}")));
    }

    let call = HostToolCall {
        session_id: shim.session_id.clone(),
        request_id: format!(
            "shim-{}",
            shim.next_request_id.fetch_add(1, Ordering::Relaxed)
        ),
        name: name.to_string(),
        arguments,
    };
    match send_to_gateway(shim, call).await {
        Ok(result) => Ok(match result.error {
            Some(message) => tool_error(message),
            None => tool_success(result.result),
        }),
        Err(message) => Err((-32603, message)),
    }
}

fn tool_error(message: String) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": message }] })
}

fn tool_success(result: Value) -> Value {
    let text = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
    let mut value = json!({ "content": [{ "type": "text", "text": text }] });
    if result.is_object() {
        value["structuredContent"] = result;
    }
    value
}

async fn send_to_gateway(shim: &Shim, call: HostToolCall) -> Result<HostToolResult, String> {
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", shim.port))
            .await
            .map_err(|e| format!("cannot reach Maestro: {e}"))?;
        let request = GatewayRequest {
            token: shim.token.clone(),
            call,
        };
        write_frame(&mut stream, &request)
            .await
            .map_err(|e| format!("cannot send to Maestro: {e}"))?;
        read_frame::<_, HostToolResult>(&mut stream)
            .await
            .map_err(|e| format!("no answer from Maestro: {e}"))
    };
    match tokio::time::timeout(GATEWAY_TIMEOUT, exchange).await {
        Ok(result) => result,
        Err(_) => Err("Maestro did not answer in time".to_string()),
    }
}

// --- Canvas payloads ---

pub(crate) fn is_canvas_tool(name: &str) -> bool {
    matches!(name, "canvas_create" | "canvas_update" | "canvas_data")
}

/// The session-update payload a canvas tool call stands for.
///
/// The gateway emits exactly this, so the renderer receives the agent's arguments verbatim.
pub(crate) fn canvas_payload(name: &str, arguments: &Value) -> Value {
    let mut payload = json!({ "sessionUpdate": name });
    if let Some(fields) = arguments.as_object() {
        for (key, value) in fields {
            payload[key] = value.clone();
        }
    }
    payload
}

// --- Tool definitions ---

fn tools() -> &'static Vec<Value> {
    static TOOLS: OnceLock<Vec<Value>> = OnceLock::new();
    TOOLS.get_or_init(build_tools)
}

/// Load the tool surface from its asset.
///
/// The descriptions are prose written for a model, and they are the only documentation it gets —
/// so they live in a document (`assets/mcp-tools.json`) rather than in `json!` literals here, the
/// same way the agent registry already does. Editing what the agent is told is then a change to
/// an asset, reviewable as writing, instead of a change to Rust.
fn build_tools() -> Vec<Value> {
    let manifest: Value =
        serde_json::from_str(TOOLS_MANIFEST).expect("the bundled MCP tool manifest is valid JSON");
    manifest
        .get("tools")
        .and_then(Value::as_array)
        .expect("the MCP tool manifest has a `tools` array")
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_shim(port: u16) -> Arc<Shim> {
        Arc::new(Shim {
            port,
            token: "right-token".to_string(),
            session_id: "session-1".to_string(),
            next_request_id: AtomicU64::new(0),
        })
    }

    /// Drive `serve` over a duplex pipe and collect one response line per request.
    async fn exchange(shim: Arc<Shim>, requests: &[Value]) -> Vec<Value> {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let task = tokio::spawn(serve(server_reader, server_writer, shim));

        for request in requests {
            let mut line = serde_json::to_vec(request).unwrap();
            line.push(b'\n');
            client.write_all(&line).await.unwrap();
        }
        client.flush().await.unwrap();

        let mut responses = Vec::new();
        let mut lines = BufReader::new(&mut client).lines();
        while responses.len() < requests.len() {
            match lines.next_line().await.unwrap() {
                Some(line) if line.trim().is_empty() => continue,
                Some(line) => responses.push(serde_json::from_str(&line).unwrap()),
                None => break,
            }
        }
        drop(lines);
        drop(client);
        let _ = task.await;
        responses
    }

    #[tokio::test]
    async fn initialize_echoes_a_supported_version_and_ignores_the_notification() {
        let responses = exchange(
            test_shim(1),
            &[json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2024-11-05" }
            })],
        )
        .await;
        assert_eq!(responses[0]["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(responses[0]["result"]["serverInfo"]["name"], "maestro");
        assert!(responses[0]["result"]["capabilities"]["tools"].is_object());

        // A notification takes no reply, so the only response here is `ping`'s.
        let responses = exchange(
            test_shim(1),
            &[json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" })],
        )
        .await;
        assert_eq!(responses[0]["result"], json!({}));
    }

    #[tokio::test]
    async fn unknown_protocol_version_falls_back_to_the_newest() {
        let responses = exchange(
            test_shim(1),
            &[json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "1999-01-01" }
            })],
        )
        .await;
        assert_eq!(
            responses[0]["result"]["protocolVersion"],
            DEFAULT_MCP_VERSION
        );
    }

    #[tokio::test]
    async fn tools_list_names_every_tool_with_an_input_schema() {
        let responses = exchange(
            test_shim(1),
            &[json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })],
        )
        .await;
        let tools = responses[0]["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "canvas_create",
                "canvas_update",
                "canvas_data",
                "canvas_await",
                "create_task",
                "get_task",
                "update_task",
                "comment_task",
                "list_tasks",
                "list_automations",
                "get_automation",
                "create_automation",
                "update_automation",
                "delete_automation",
                "run_automation",
                "list_automation_runs",
                "get_automation_run",
                "list_templates",
                "get_template",
                "update_template",
                "save_as_template",
                "delete_template"
            ]
        );
        for tool in tools {
            assert!(tool["description"].as_str().is_some_and(|d| !d.is_empty()));
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn unknown_method_is_a_method_not_found_error() {
        let responses = exchange(
            test_shim(1),
            &[json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" })],
        )
        .await;
        assert_eq!(responses[0]["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn a_wrong_token_is_rejected_by_the_gateway() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: GatewayRequest = read_frame(&mut stream).await.unwrap();
            let reply = HostToolResult {
                session_id: request.call.session_id,
                request_id: request.call.request_id,
                result: Value::Null,
                error: (request.token != "the-only-token").then(|| "unauthorized".to_string()),
            };
            write_frame(&mut stream, &reply).await.unwrap();
        });

        let responses = exchange(
            test_shim(port),
            &[json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": "list_tasks", "arguments": {} }
            })],
        )
        .await;
        assert_eq!(responses[0]["result"]["isError"], true);
        assert_eq!(responses[0]["result"]["content"][0]["text"], "unauthorized");
    }

    #[test]
    fn canvas_payload_names_the_session_update_and_carries_the_arguments() {
        let created = canvas_payload(
            "canvas_create",
            &json!({"surfaceId": "s", "title": "T", "html": "<p id='x'>hi</p>"}),
        );
        assert_eq!(created["sessionUpdate"], "canvas_create");
        assert_eq!(created["html"], "<p id='x'>hi</p>");
        // The quoting rule the old fence encoding needed does not apply to MCP arguments.
        let quoted = canvas_payload(
            "canvas_update",
            &json!({"surfaceId": "s", "html": "<p class=\"x\">\\o/</p>"}),
        );
        assert_eq!(quoted["html"], "<p class=\"x\">\\o/</p>");
    }
}
