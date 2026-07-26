//! Project-scoped MCP server configuration.
//!
//! Reads `.mcp.json` from the session's working directory — the format Claude Code, Cursor and
//! others already write, so a project that configures MCP servers for those tools gets them here
//! without a second config file. Because sessions run in worktrees, each worktree carries the
//! copy committed on its own branch.
//!
//! We consume a format we do not own, so only the fields ACP can express are read. `timeout`,
//! `oauth` and anything else are ignored rather than rejected, and a transport ACP has no
//! representation for (`ws`) is skipped with a reason instead of failing the session.
//!
//! A bad entry never blocks a session: starting an agent with no tools beats refusing to start
//! over a typo. Every skip is reported through `send_diag` so the reason reaches the host log.

use std::collections::BTreeMap;
use std::path::Path;

use agent_client_protocol as acp;
use acp::schema::v1::{
    EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio,
};
use serde::Deserialize;

pub(crate) const MCP_CONFIG_FILE: &str = ".mcp.json";

/// Which remote transports the agent said it can connect to.
///
/// There is no capability for stdio — it is the v1 baseline every agent must support.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct McpTransportSupport {
    pub http: bool,
    pub sse: bool,
}

/// Servers to send on `session/new` / `session/load`, plus a reason for each one dropped.
#[derive(Debug, Default)]
pub(crate) struct LoadedMcpServers {
    pub servers: Vec<McpServer>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct McpJsonFile {
    /// `BTreeMap`, not `HashMap`: the order reaches the agent and the diagnostics, and a random
    /// one per run makes both harder to read and to compare between runs.
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpJsonEntry>,
}

#[derive(Debug, Deserialize)]
struct McpJsonEntry {
    #[serde(default, rename = "type")]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

/// Read and convert `<cwd>/.mcp.json`. A missing file is the common case and yields no servers
/// and no complaint.
pub(crate) async fn load_mcp_servers(cwd: &str, support: McpTransportSupport) -> LoadedMcpServers {
    let path = Path::new(cwd).join(MCP_CONFIG_FILE);
    let contents = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LoadedMcpServers::default(),
        Err(e) => {
            return LoadedMcpServers {
                servers: Vec::new(),
                skipped: vec![format!("cannot read {}: {e}", path.display())],
            };
        }
    };
    parse_mcp_servers(&contents, support, &std::env::vars().collect())
}

/// Split from `load_mcp_servers` so the conversion is testable without a filesystem or a
/// process environment.
pub(crate) fn parse_mcp_servers(
    contents: &str,
    support: McpTransportSupport,
    env: &BTreeMap<String, String>,
) -> LoadedMcpServers {
    let parsed: McpJsonFile = match serde_json::from_str(contents) {
        Ok(p) => p,
        Err(e) => {
            return LoadedMcpServers {
                servers: Vec::new(),
                skipped: vec![format!("{MCP_CONFIG_FILE} is not valid JSON: {e}")],
            };
        }
    };

    let mut out = LoadedMcpServers::default();
    for (name, entry) in parsed.mcp_servers {
        match convert_entry(&name, entry, support, env) {
            Ok(server) => out.servers.push(server),
            Err(reason) => out.skipped.push(format!("{name}: {reason}")),
        }
    }
    out
}

fn convert_entry(
    name: &str,
    entry: McpJsonEntry,
    support: McpTransportSupport,
    env: &BTreeMap<String, String>,
) -> Result<McpServer, String> {
    // `streamable-http` is the MCP specification's name for the same transport, accepted so
    // configurations copied from a server's own documentation work unchanged.
    let transport = match entry.transport.as_deref() {
        Some("http" | "streamable-http") => "http",
        Some("sse") => "sse",
        Some("stdio") => "stdio",
        Some(other) => {
            return Err(format!(
                "transport \"{other}\" has no ACP equivalent, so it cannot be forwarded"
            ));
        }
        // An entry with a url and no type is a configuration error rather than a stdio server:
        // reading it as stdio would fail later with a confusing missing-command error.
        None if entry.url.is_some() => {
            return Err(
                "has a \"url\" but no \"type\"; add \"type\": \"http\" or \"sse\"".to_string()
            );
        }
        None => "stdio",
    };

    let mut missing = Vec::new();
    let server = match transport {
        "stdio" => {
            let command = entry
                .command
                .ok_or_else(|| "stdio server has no \"command\"".to_string())?;
            McpServer::Stdio(
                McpServerStdio::new(name, expand(&command, env, &mut missing))
                    .args(
                        entry
                            .args
                            .iter()
                            .map(|a| expand(a, env, &mut missing))
                            .collect(),
                    )
                    .env(
                        entry
                            .env
                            .iter()
                            .map(|(k, v)| EnvVariable::new(k, expand(v, env, &mut missing)))
                            .collect(),
                    ),
            )
        }
        "http" | "sse" => {
            let url = entry
                .url
                .ok_or_else(|| format!("{transport} server has no \"url\""))?;
            let supported = if transport == "http" {
                support.http
            } else {
                support.sse
            };
            if !supported {
                return Err(format!(
                    "this agent does not support {transport} MCP servers"
                ));
            }
            let url = expand(&url, env, &mut missing);
            let headers: Vec<HttpHeader> = entry
                .headers
                .iter()
                .map(|(k, v)| HttpHeader::new(k, expand(v, env, &mut missing)))
                .collect();
            if transport == "http" {
                McpServer::Http(McpServerHttp::new(name, url).headers(headers))
            } else {
                McpServer::Sse(McpServerSse::new(name, url).headers(headers))
            }
        }
        _ => unreachable!("transport is one of the matched literals"),
    };

    if !missing.is_empty() {
        // Matches Claude Code: the entry still loads with the placeholder text left in place, so
        // the agent reports a real connection error rather than the server vanishing silently.
        crate::send_diag(
            "warn",
            format!(
                "[mcp] {name}: unset variable(s) {} left unexpanded",
                missing.join(", ")
            ),
        );
    }
    Ok(server)
}

/// Expand `${VAR}` and `${VAR:-default}`.
///
/// An unset variable with no default is left as written and its name recorded, rather than
/// expanding to empty — an empty command or url fails in ways that do not point back here.
fn expand(input: &str, env: &BTreeMap<String, String>, missing: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            // No closing brace: not a reference, so keep the remainder verbatim.
            out.push_str(&rest[start..]);
            return out;
        };
        let body = &after[..end];
        let (name, default) = match body.split_once(":-") {
            Some((name, default)) => (name, Some(default)),
            None => (body, None),
        };
        match env.get(name) {
            Some(value) => out.push_str(value),
            None => match default {
                Some(default) => out.push_str(default),
                None => {
                    missing.push(name.to_string());
                    out.push_str(&rest[start..start + 2 + end + 1]);
                }
            },
        }
        rest = &after[end + 1..];
    }

    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    const BOTH: McpTransportSupport = McpTransportSupport {
        http: true,
        sse: true,
    };
    const NEITHER: McpTransportSupport = McpTransportSupport {
        http: false,
        sse: false,
    };

    #[test]
    fn entry_without_type_is_stdio() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"fs":{"command":"npx","args":["-y","server-fs"]}}}"#,
            NEITHER,
            &env(&[]),
        );
        assert!(loaded.skipped.is_empty(), "{:?}", loaded.skipped);
        match &loaded.servers[..] {
            [McpServer::Stdio(s)] => {
                assert_eq!(s.name, "fs");
                assert_eq!(s.command.to_str().unwrap(), "npx");
                assert_eq!(s.args, vec!["-y", "server-fs"]);
            }
            other => panic!("expected one stdio server, got {other:?}"),
        }
    }

    #[test]
    fn stdio_needs_no_capability() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"a":{"command":"x"}}}"#,
            NEITHER,
            &env(&[]),
        );
        assert_eq!(loaded.servers.len(), 1);
        assert!(loaded.skipped.is_empty());
    }

    #[test]
    fn streamable_http_is_an_alias_for_http() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"a":{"type":"streamable-http","url":"https://e.com/mcp"}}}"#,
            BOTH,
            &env(&[]),
        );
        assert!(matches!(loaded.servers[..], [McpServer::Http(_)]));
    }

    #[test]
    fn remote_transports_are_gated_on_agent_capabilities() {
        let config = r#"{"mcpServers":{
            "h":{"type":"http","url":"https://e.com/mcp"},
            "s":{"type":"sse","url":"https://e.com/sse"}
        }}"#;

        let loaded = parse_mcp_servers(config, NEITHER, &env(&[]));
        assert!(loaded.servers.is_empty());
        assert_eq!(loaded.skipped.len(), 2);
        assert!(loaded.skipped.iter().all(|s| s.contains("does not support")));

        let http_only = McpTransportSupport {
            http: true,
            sse: false,
        };
        let loaded = parse_mcp_servers(config, http_only, &env(&[]));
        assert!(matches!(loaded.servers[..], [McpServer::Http(_)]));
        assert_eq!(loaded.skipped.len(), 1);
    }

    #[test]
    fn url_without_type_is_reported_not_read_as_stdio() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"a":{"url":"https://e.com/mcp"}}}"#,
            BOTH,
            &env(&[]),
        );
        assert!(loaded.servers.is_empty());
        assert!(loaded.skipped[0].contains("no \"type\""), "{:?}", loaded.skipped);
    }

    #[test]
    fn transport_acp_cannot_express_is_skipped_with_a_reason() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"a":{"type":"ws","url":"wss://e.com/s"}}}"#,
            BOTH,
            &env(&[]),
        );
        assert!(loaded.servers.is_empty());
        assert!(loaded.skipped[0].contains("no ACP equivalent"), "{:?}", loaded.skipped);
    }

    #[test]
    fn one_bad_entry_does_not_drop_the_others() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"good":{"command":"x"},"bad":{"type":"ws","url":"wss://e"}}}"#,
            BOTH,
            &env(&[]),
        );
        assert_eq!(loaded.servers.len(), 1);
        assert_eq!(loaded.skipped.len(), 1);
    }

    #[test]
    fn unknown_fields_are_ignored_not_rejected() {
        // `timeout` and `oauth` are Claude Code's, and ACP has nowhere to put them.
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{"a":{"command":"x","timeout":600000,"oauth":{"clientId":"c"}}}}"#,
            BOTH,
            &env(&[]),
        );
        assert_eq!(loaded.servers.len(), 1, "{:?}", loaded.skipped);
    }

    #[test]
    fn malformed_json_skips_every_server_rather_than_erroring() {
        let loaded = parse_mcp_servers("{ not json", BOTH, &env(&[]));
        assert!(loaded.servers.is_empty());
        assert_eq!(loaded.skipped.len(), 1);
    }

    #[test]
    fn missing_key_yields_nothing() {
        let loaded = parse_mcp_servers("{}", BOTH, &env(&[]));
        assert!(loaded.servers.is_empty());
        assert!(loaded.skipped.is_empty());
    }

    #[test]
    fn expands_set_variables_and_defaults() {
        let e = env(&[("HOME", "/home/x"), ("TOKEN", "secret")]);
        let mut missing = Vec::new();
        assert_eq!(expand("${HOME}/bin", &e, &mut missing), "/home/x/bin");
        assert_eq!(expand("Bearer ${TOKEN}", &e, &mut missing), "Bearer secret");
        assert_eq!(expand("${NOPE:-fallback}", &e, &mut missing), "fallback");
        assert_eq!(expand("${HOME:-unused}", &e, &mut missing), "/home/x");
        assert_eq!(expand("${A}-${B:-b}", &env(&[("A", "a")]), &mut missing), "a-b");
        assert!(missing.is_empty());
    }

    #[test]
    fn unset_variable_is_left_verbatim_and_recorded() {
        let mut missing = Vec::new();
        assert_eq!(expand("${GONE}/x", &env(&[]), &mut missing), "${GONE}/x");
        assert_eq!(missing, vec!["GONE"]);
    }

    #[test]
    fn text_that_is_not_a_reference_survives_untouched() {
        let mut missing = Vec::new();
        assert_eq!(expand("plain", &env(&[]), &mut missing), "plain");
        assert_eq!(expand("${unclosed", &env(&[]), &mut missing), "${unclosed");
        assert_eq!(expand("cost: $5", &env(&[]), &mut missing), "cost: $5");
        assert!(missing.is_empty());
    }

    #[test]
    fn expansion_applies_to_env_values_and_headers() {
        let loaded = parse_mcp_servers(
            r#"{"mcpServers":{
                "a":{"command":"${BIN}","env":{"K":"${V}"}},
                "b":{"type":"http","url":"${BASE}/mcp","headers":{"Authorization":"Bearer ${V}"}}
            }}"#,
            BOTH,
            &env(&[("BIN", "/usr/bin/s"), ("V", "val"), ("BASE", "https://e.com")]),
        );
        match &loaded.servers[..] {
            [McpServer::Stdio(a), McpServer::Http(b)] => {
                assert_eq!(a.command.to_str().unwrap(), "/usr/bin/s");
                assert_eq!(a.env[0].value, "val");
                assert_eq!(b.url, "https://e.com/mcp");
                assert_eq!(b.headers[0].value, "Bearer val");
            }
            other => panic!("unexpected servers: {other:?}"),
        }
    }
}
