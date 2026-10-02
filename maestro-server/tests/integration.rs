//! Integration tests for maestro-server binary via stdin/stdout pipe.
//!
//! Spawns the actual binary and communicates using the maestro-protocol wire format
//! (4-byte LE length prefix + JSON body). Tests the error paths that don't require
//! a real ACP agent subprocess, verifying:
//!
//! - Protocol framing works end-to-end (client write → server read → server write → client read)
//! - SpawnRequest with unknown agent returns a structured Error response (not a hang or crash)
//! - PromptRequest for an unknown session returns Error "unknown session: ..."
//! - PermitResponse/Cancel for unknown sessions are silently ignored (no crash, no response)
//! - Server exits cleanly when stdin closes (EOF)
//!
//! Happy-path tests (successful spawn + forwarded prompt + unblocked permission) require
//! a live ACP agent subprocess and are covered by manual verification in VALIDATION.md.
//!
//! Timeout strategy: tests expecting a response block on read_exact (server MUST respond).
//! Tests expecting NO response close stdin, wait for server exit, then assert stdout was empty.
//! This avoids needing set_read_timeout (unavailable on ChildStdout).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use maestro_protocol::{
    CancelRequest, HandshakeRequest, ListAgentsRequest, MaestroRpcMessage, PermissionResponse,
    PromptRequest, ServerRequest, ServerResponse, SpawnRequest, PROTOCOL_VERSION,
};

fn server_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join(format!(
            "target/debug/maestro-server{}",
            std::env::consts::EXE_SUFFIX
        ))
}

fn write_msg(writer: &mut impl Write, msg: &MaestroRpcMessage) {
    let frame = maestro_protocol::encode_message(None, msg).expect("encode");
    writer.write_all(&frame).expect("write frame");
    writer.flush().expect("flush");
}

fn read_frame(reader: &mut impl Read) -> MaestroRpcMessage {
    maestro_protocol::read_message_sync(reader).expect("read frame")
}

// Skip Diagnostic and Ping frames — both arrive asynchronously and are not
// relevant to the error-path assertions these tests make.
fn read_msg(reader: &mut impl Read) -> MaestroRpcMessage {
    loop {
        match read_frame(reader) {
            MaestroRpcMessage::Response(ServerResponse::Diagnostic(_)) => continue,
            MaestroRpcMessage::Response(ServerResponse::Ping { .. }) => continue,
            other => return other,
        }
    }
}

fn spawn_server() -> std::process::Child {
    spawn_server_with_home(None)
}

/// `home` redirects the home directory the server reads its user configuration from, so a test
/// can supply a `custom-agents.json` without touching the home of whoever is running the suite.
fn spawn_server_with_home(home: Option<&std::path::Path>) -> std::process::Child {
    let bin = server_binary();
    assert!(
        bin.exists(),
        "maestro-server binary not found at {:?} — run `cargo build -p maestro-server` first",
        bin
    );
    let mut command = Command::new(&bin);
    if let Some(home) = home {
        command.env("HOME", home).env("USERPROFILE", home);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn maestro-server")
}

/// Perform the protocol handshake that the server requires before any other requests.
fn do_handshake(stdin: &mut impl Write, stdout: &mut impl Read) {
    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        })),
    );
    let resp = read_msg(stdout);
    assert!(
        matches!(
            resp,
            MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))
        ),
        "expected HandshakeOk, got: {}",
        serde_json::to_string(&resp).unwrap()
    );
}

/// SpawnRequest with a nonexistent agent_id must return ServerResponse::Error.
/// Proves protocol framing works end-to-end and the Spawn handler rejects gracefully.
#[test]
fn test_spawn_unknown_agent_returns_error() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "nonexistent-acp-agent-xyz-12345".to_string(),
            session_id: "session-1".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: Default::default(),
        })),
    );

    let resp = read_msg(stdout);
    match resp {
        MaestroRpcMessage::Response(ServerResponse::Error(e)) => {
            // Error must mention the agent name or the spawn failure
            assert!(
                e.message.contains("nonexistent-acp-agent-xyz-12345")
                    || e.message.contains("failed to spawn")
                    || e.message.contains("No such file")
                    || e.message.contains("not found"),
                "error must describe spawn failure, got: {}",
                e.message
            );
        }
        other => panic!(
            "expected Error response, got: {}",
            serde_json::to_string(&other).unwrap()
        ),
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// After a failed SpawnRequest the server loop continues.
/// A subsequent PromptRequest for the unregistered session_id must return
/// Error("unknown session: ...") — not a hang or crash.
/// Proves the Prompt dispatch branch is reached and the server recovers.
#[test]
fn test_prompt_after_failed_spawn_returns_unknown_session_error() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    // Step 1: failed spawn — consume Error
    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "no-such-agent".to_string(),
            session_id: "session-99".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: Default::default(),
        })),
    );
    let spawn_resp = read_msg(stdout);
    assert!(
        matches!(
            spawn_resp,
            MaestroRpcMessage::Response(ServerResponse::Error(_))
        ),
        "expected Error from failed spawn, got: {}",
        serde_json::to_string(&spawn_resp).unwrap()
    );

    // Step 2: prompt on the never-registered session
    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "session-99".to_string(),
            content: serde_json::Value::String("hello world".to_string()),
        })),
    );
    let prompt_resp = read_msg(stdout);
    match prompt_resp {
        MaestroRpcMessage::Response(ServerResponse::Error(e)) => {
            assert!(
                e.message.contains("unknown session") || e.message.contains("session-99"),
                "error must mention unknown session, got: {}",
                e.message
            );
        }
        other => panic!(
            "expected Error(unknown session), got: {}",
            serde_json::to_string(&other).unwrap()
        ),
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// PermitResponse for an unknown session must be silently ignored.
/// Approach: close stdin after sending, drain stdout to EOF, assert nothing was written.
#[test]
fn test_permit_response_unknown_session_produces_no_output() {
    let mut child = spawn_server();

    {
        let stdin = child.stdin.as_mut().unwrap();
        let stdout = child.stdout.as_mut().unwrap();
        do_handshake(stdin, stdout);
        write_msg(
            stdin,
            &MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
                session_id: "session-never".to_string(),
                request_id: "perm-001".to_string(),
                option_id: Some("default".into()),
            })),
        );
        // Drop stdin here (end of scope) — causes server to receive EOF and exit
    }
    drop(child.stdin.take());

    // Read all stdout until EOF (server has exited)
    let mut output = Vec::new();
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_to_end(&mut output)
        .expect("drain stdout");
    let _ = child.wait();

    // Diagnostics, not raw bytes — same race as the Cancel twin below: `send_diag` writes through
    // a channel, so the server's own startup reports land here on their own schedule.
    let mut remaining = std::io::Cursor::new(&output);
    let mut unexpected = Vec::new();
    while (remaining.position() as usize) < output.len() {
        match read_frame(&mut remaining) {
            MaestroRpcMessage::Response(ServerResponse::Diagnostic(_)) => continue,
            MaestroRpcMessage::Response(ServerResponse::Ping { .. }) => continue,
            other => unexpected.push(other),
        }
    }

    assert!(
        unexpected.is_empty(),
        "server must answer nothing for PermitResponse to unknown session, got {unexpected:?}"
    );
}

/// Cancel for an unknown session must be silently ignored with no output.
#[test]
fn test_cancel_unknown_session_produces_no_output() {
    let mut child = spawn_server();

    {
        let stdin = child.stdin.as_mut().unwrap();
        let stdout = child.stdout.as_mut().unwrap();
        do_handshake(stdin, stdout);
        write_msg(
            stdin,
            &MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest {
                session_id: "session-ghost".to_string(),
            })),
        );
    }
    drop(child.stdin.take());

    let mut output = Vec::new();
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_to_end(&mut output)
        .expect("drain stdout");
    let _ = child.wait();

    // Diagnostics, not raw bytes: `send_diag` writes through a channel, so anything the server
    // reports about its own startup — the MCP gateway's port, for one — lands here on its own
    // schedule. Asserting emptiness made this test a race that only lost on a slower machine.
    let mut remaining = std::io::Cursor::new(&output);
    let mut unexpected = Vec::new();
    while (remaining.position() as usize) < output.len() {
        match read_frame(&mut remaining) {
            MaestroRpcMessage::Response(ServerResponse::Diagnostic(_)) => continue,
            MaestroRpcMessage::Response(ServerResponse::Ping { .. }) => continue,
            other => unexpected.push(other),
        }
    }

    assert!(
        unexpected.is_empty(),
        "server must answer nothing for Cancel of unknown session, got {unexpected:?}"
    );
}

/// Protocol framing handles large payloads correctly.
/// Sends a PromptRequest with 64 KB content, verifies the Error response
/// is correctly framed and parseable (length prefix matches body size).
#[test]
fn test_protocol_framing_large_prompt_payload() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    // Consume spawn error first
    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "no-agent".to_string(),
            session_id: "session-large".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: Default::default(),
        })),
    );
    let _ = read_msg(stdout);

    // 64 KB prompt
    let large_content = serde_json::Value::String("x".repeat(64 * 1024));
    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "session-large".to_string(),
            content: large_content,
        })),
    );

    let resp = read_msg(stdout);
    assert!(
        matches!(resp, MaestroRpcMessage::Response(ServerResponse::Error(_))),
        "large payload must still produce a parseable Error response"
    );

    let _ = child.kill();
    let _ = child.wait();
}

/// Server exits cleanly (code 0) when stdin closes — simulates Tauri host exit.
#[test]
fn test_server_exits_cleanly_on_stdin_close() {
    let mut child = spawn_server();
    drop(child.stdin.take());
    let status = child.wait().expect("wait for server");
    assert_eq!(status.code(), Some(0), "server must exit 0 on stdin close");
}

/// ListAgents end-to-end: spawns maestro-server, sends ListAgentsRequest, asserts
/// the server responds with ListAgentsOk (possibly empty list if no runtimes installed)
/// or a structured Error if the CDN registry is unreachable.
///
/// This is the same flow the Tauri host uses in `query_list_agents_local` in
/// `src-tauri/src/ipc/acp_handlers.rs`: spawn server, write request, close stdin, read response.
#[test]
fn test_list_agents_returns_ok_response() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {})),
    );

    let resp = read_msg(stdout);
    println!("response: {}", serde_json::to_string_pretty(&resp).unwrap());
    match resp {
        MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(list)) => {
            println!("agents ({}):", list.agents.len());
            for agent in &list.agents {
                println!("  {} — {} (icon: {})", agent.id, agent.name, agent.icon);
                assert!(!agent.id.is_empty(), "agent id must be non-empty");
                assert!(!agent.name.is_empty(), "agent name must be non-empty");
            }
        }
        other => panic!(
            "expected ListAgentsOk (backup guarantees success), got: {}",
            serde_json::to_string(&other).unwrap()
        ),
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// An agent the user declared in `~/.maestro/custom-agents.json` must reach the picker, and it is
/// only worth asserting against the real binary: the file is read from the home directory of
/// whichever machine the server runs on, which is the part a unit test cannot stand in for.
#[test]
fn test_list_agents_includes_user_defined_custom_agents() {
    let home = tempfile::tempdir().expect("temp home");
    let config_dir = home.path().join(".maestro");
    std::fs::create_dir_all(&config_dir).expect("create .maestro");
    std::fs::write(
        config_dir.join("custom-agents.json"),
        r#"{
          "agents": [
            {
              "id": "ollama-claude-acp",
              "name": "Claude Code (Ollama)",
              "distribution": {
                "npx": {
                  "package": "@agentclientprotocol/claude-agent-acp@0.64.0",
                  "env": { "ANTHROPIC_BASE_URL": "http://localhost:11434" }
                }
              }
            }
          ]
        }"#,
    )
    .expect("write custom-agents.json");

    let mut child = spawn_server_with_home(Some(home.path()));
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    write_msg(
        stdin,
        &MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {})),
    );

    let resp = read_msg(stdout);
    match resp {
        MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(list)) => {
            let custom = list
                .agents
                .iter()
                .find(|agent| agent.id == "ollama-claude-acp")
                .unwrap_or_else(|| {
                    panic!(
                        "custom agent missing from {:?}",
                        list.agents.iter().map(|a| &a.id).collect::<Vec<_>>()
                    )
                });
            assert_eq!(custom.name, "Claude Code (Ollama)");
            assert_eq!(custom.spawn_deps, vec!["npx".to_string()]);
            assert!(
                list.agents.iter().any(|agent| agent.id == "claude-acp"),
                "the bundled agents must still be listed alongside it"
            );
        }
        other => panic!(
            "expected ListAgentsOk, got: {}",
            serde_json::to_string(&other).unwrap()
        ),
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn write_msg_with_id(writer: &mut impl Write, id: Option<u64>, request: ServerRequest) {
    let frame =
        maestro_protocol::encode_message(id, &MaestroRpcMessage::Request(request)).expect("encode");
    writer.write_all(&frame).expect("write frame");
    writer.flush().expect("flush");
}

/// `read_msg`, keeping the id the frame carried.
fn read_msg_with_id(reader: &mut impl Read) -> (Option<u64>, ServerResponse) {
    loop {
        match maestro_protocol::read_message_with_id_sync(reader).expect("read frame") {
            (_, MaestroRpcMessage::Response(ServerResponse::Diagnostic(_))) => continue,
            (_, MaestroRpcMessage::Response(ServerResponse::Ping { .. })) => continue,
            (id, MaestroRpcMessage::Response(response)) => return (id, response),
            (_, other) => panic!("expected a response, got: {other:?}"),
        }
    }
}

/// A sessionless reply names the request it answers. Two requests of one type are the case the
/// host cannot tell apart by reply type alone, so both are written before either is read.
#[test]
fn test_sessionless_reply_echoes_request_id() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    let list = || ServerRequest::ListAgents(maestro_protocol::ListAgentsRequest {});
    write_msg_with_id(stdin, Some(41), list());
    write_msg_with_id(stdin, Some(7), list());
    for expected in [41, 7] {
        let (id, response) = read_msg_with_id(stdout);
        assert!(
            matches!(response, ServerResponse::ListAgentsOk(_)),
            "expected ListAgentsOk, got: {response:?}"
        );
        assert_eq!(id, Some(expected));
    }

    write_msg_with_id(stdin, None, list());
    let (id, response) = read_msg_with_id(stdout);
    assert!(
        matches!(response, ServerResponse::ListAgentsOk(_)),
        "expected ListAgentsOk, got: {response:?}"
    );
    assert_eq!(id, None, "a request without an id is answered without one");

    write_msg_with_id(
        stdin,
        Some(99),
        ServerRequest::PreviewSchedule(maestro_protocol::PreviewScheduleRequest {
            cron: "not a cron expression".to_string(),
            timezone: "UTC".to_string(),
        }),
    );
    let (id, response) = read_msg_with_id(stdout);
    assert!(
        matches!(response, ServerResponse::Error(_)),
        "expected Error, got: {response:?}"
    );
    assert_eq!(id, Some(99), "a failure still names its request");

    let _ = child.kill();
    let _ = child.wait();
}

/// A load that no later attempt could get past says so, and names its session: that is what lets
/// the host drop its entry for it and close the conversation's row instead of retrying forever.
#[test]
fn test_load_in_a_missing_folder_reports_the_session_gone() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    let gone = tempfile::tempdir().expect("tempdir");
    let cwd = gone.path().join("deleted").to_string_lossy().into_owned();
    write_msg_with_id(
        stdin,
        None,
        ServerRequest::SessionLoad(maestro_protocol::SessionLoadRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "routing-1".to_string(),
            resume_session_id: "conversation-1".to_string(),
            cwd,
            additional_directories: Vec::new(),
            project_path: None,
            meta: maestro_protocol::SessionMeta::default(),
        }),
    );
    match read_msg_with_id(stdout).1 {
        ServerResponse::Error(error) => {
            assert_eq!(error.session_id.as_deref(), Some("routing-1"));
            assert!(
                error
                    .message
                    .starts_with(maestro_protocol::SESSION_GONE_ERROR),
                "got: {}",
                error.message
            );
        }
        other => panic!("expected Error, got: {other:?}"),
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// The project store answers with no agent involved: an empty project lists nothing, and a
/// conversation renamed before it ever had a row comes back closed, under the new name.
#[test]
fn test_project_sessions_list_and_rename() {
    // Its own daemon directory, so the store this writes is not the one of whoever runs the suite.
    let daemon_dir = tempfile::tempdir().expect("tempdir");
    let project = tempfile::tempdir().expect("tempdir");
    let project_path = project.path().to_string_lossy().into_owned();
    let mut child = Command::new(server_binary())
        .env(maestro_protocol::DAEMON_DIR_ENV, daemon_dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn maestro-server");
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    let list = |include_closed| {
        ServerRequest::ListProjectSessions(maestro_protocol::ListProjectSessionsRequest {
            project_path: project_path.clone(),
            include_closed,
        })
    };

    write_msg_with_id(stdin, Some(11), list(true));
    let (id, response) = read_msg_with_id(stdout);
    assert_eq!(id, Some(11));
    match response {
        ServerResponse::ListProjectSessionsOk(listed) => assert!(listed.sessions.is_empty()),
        other => panic!("expected ListProjectSessionsOk, got: {other:?}"),
    }

    write_msg_with_id(
        stdin,
        Some(12),
        ServerRequest::RenameSession(maestro_protocol::RenameSessionRequest {
            // A trailing separator, so the row is only found if both requests are canonicalized.
            project_path: format!("{project_path}/"),
            agent_id: "claude".to_string(),
            acp_session_id: "before-the-table".to_string(),
            cwd: project_path.clone(),
            name: "Renamed".to_string(),
        }),
    );
    let (id, response) = read_msg_with_id(stdout);
    assert_eq!(id, Some(12));
    assert!(
        matches!(response, ServerResponse::RenameSessionOk),
        "expected RenameSessionOk, got: {response:?}"
    );

    write_msg_with_id(stdin, Some(13), list(false));
    let (_, response) = read_msg_with_id(stdout);
    match response {
        ServerResponse::ListProjectSessionsOk(listed) => assert!(
            listed.sessions.is_empty(),
            "a closed row is not listed unless asked for"
        ),
        other => panic!("expected ListProjectSessionsOk, got: {other:?}"),
    }

    write_msg_with_id(stdin, Some(14), list(true));
    let (id, response) = read_msg_with_id(stdout);
    assert_eq!(id, Some(14));
    match response {
        ServerResponse::ListProjectSessionsOk(listed) => {
            assert_eq!(listed.sessions.len(), 1);
            let session = &listed.sessions[0];
            assert_eq!(session.acp_session_id, "before-the-table");
            assert_eq!(session.meta.session_name.as_deref(), Some("Renamed"));
            assert_eq!(session.cwd, project_path);
            assert!(session.closed);
            assert!(session.live.is_none());
        }
        other => panic!("expected ListProjectSessionsOk, got: {other:?}"),
    }

    // Closing by key answers for a row that is closed already and for one that was never there:
    // the host sends it after a failed load and has nothing to do with a refusal.
    for (request_id, acp_session_id) in [(15, "before-the-table"), (16, "never-recorded")] {
        write_msg_with_id(
            stdin,
            Some(request_id),
            ServerRequest::CloseProjectSession(maestro_protocol::CloseProjectSessionRequest {
                agent_id: "claude".to_string(),
                acp_session_id: acp_session_id.to_string(),
            }),
        );
        let (id, response) = read_msg_with_id(stdout);
        assert_eq!(id, Some(request_id));
        assert!(
            matches!(response, ServerResponse::CloseProjectSessionOk),
            "expected CloseProjectSessionOk, got: {response:?}"
        );
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// A slow request is answered off the main loop, so a fast one sent after it is not queued behind
/// it. The slow one is a pre-initialize of an agent that starts and never answers `initialize`.
#[test]
fn test_fast_request_is_answered_while_a_slow_one_is_outstanding() {
    #[cfg(windows)]
    let (cmd, args) = (
        "powershell",
        r#"["-NoProfile", "-Command", "Start-Sleep 30"]"#,
    );
    #[cfg(not(windows))]
    let (cmd, args) = ("sleep", r#"["30"]"#);
    let platforms = [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-aarch64",
        "linux-x86_64",
        "windows-x86_64",
        "windows-aarch64",
    ]
    .map(|platform| format!(r#""{platform}": {{ "cmd": "{cmd}", "args": {args} }}"#))
    .join(", ");

    let home = tempfile::tempdir().expect("temp home");
    let config_dir = home.path().join(".maestro");
    std::fs::create_dir_all(&config_dir).expect("create .maestro");
    std::fs::write(
        config_dir.join("custom-agents.json"),
        format!(
            r#"{{ "agents": [ {{ "id": "never-answers", "name": "Never answers",
                "distribution": {{ "binary": {{ {platforms} }} }} }} ] }}"#
        ),
    )
    .expect("write custom-agents.json");

    let mut child = spawn_server_with_home(Some(home.path()));
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();
    do_handshake(stdin, stdout);

    write_msg_with_id(
        stdin,
        Some(21),
        ServerRequest::PreInitialize(maestro_protocol::PreInitializeRequest {
            agent_id: "never-answers".to_string(),
            cwd: home.path().to_string_lossy().into_owned(),
        }),
    );
    write_msg_with_id(
        stdin,
        Some(22),
        ServerRequest::ListAgents(ListAgentsRequest {}),
    );

    let (id, response) = read_msg_with_id(stdout);
    assert_eq!(id, Some(22), "got {response:?} first");
    assert!(
        matches!(response, ServerResponse::ListAgentsOk(_)),
        "expected ListAgentsOk, got: {response:?}"
    );

    let _ = child.kill();
    let _ = child.wait();
}

/// A daemon started by `attach` in a directory of its own, shut down when dropped, even by a
/// failing assertion, so no test leaves a resident server behind.
struct Daemon {
    dir: tempfile::TempDir,
}

impl Daemon {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    /// One window: an `attach` relay, handshaken.
    fn attach(&self) -> std::process::Child {
        let mut child = Command::new(server_binary())
            .arg("attach")
            .env(maestro_protocol::DAEMON_DIR_ENV, self.dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn maestro-server attach");
        do_handshake(
            child.stdin.as_mut().unwrap(),
            child.stdout.as_mut().unwrap(),
        );
        child
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let Ok(body) = std::fs::read(self.dir.path().join("runtime.json")) else {
            return;
        };
        let runtime: serde_json::Value = serde_json::from_slice(&body).expect("runtime.json");
        let port = runtime["port"].as_u64().expect("port") as u16;
        let token = runtime["token"].as_str().expect("token");
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.write_all(format!("{token}\nSHUTDOWN\n").as_bytes());
        }
        // The lock is released on exit, which is what lets the directory go.
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// Two windows on one daemon: what one writes, the other is told of, under the path the daemon
/// resolved, and each project numbers its tasks from 1.
#[test]
fn test_task_changes_reach_every_window() {
    use maestro_protocol::{
        ApplyTaskTransitionRequest, BranchMode, CreateTaskRequest, ProjectRef, TaskStatus,
        TaskTransition, WorkspaceMode,
    };

    let daemon = Daemon::new();
    let mut a = daemon.attach();
    let mut b = daemon.attach();
    let projects = [
        tempfile::tempdir().expect("tempdir"),
        tempfile::tempdir().expect("tempdir"),
    ];
    let canonical = |dir: &tempfile::TempDir| {
        let path = std::fs::canonicalize(dir.path()).unwrap();
        let path = path.to_string_lossy().replace('\\', "/");
        path.strip_prefix("//?/").unwrap_or(&path).to_string()
    };
    let create = |dir: &tempfile::TempDir| {
        ServerRequest::CreateTask(CreateTaskRequest {
            // A trailing separator, so the rows only line up if the daemon canonicalizes.
            project_path: format!("{}/", dir.path().to_string_lossy()),
            title: "Fix login".to_string(),
            description: None,
            skills: vec![],
            labels: vec![],
            base_branch: "main".to_string(),
            agent_id: None,
            priority: None,
            auto_approve: false,
            workspace_mode: WorkspaceMode::RepositoryDirectory,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            model_override: None,
        })
    };
    let changed = |dir| {
        ServerResponse::TasksChanged(ProjectRef {
            project_path: canonical(dir),
        })
    };

    let (a_in, a_out) = (a.stdin.as_mut().unwrap(), a.stdout.as_mut().unwrap());
    let b_out = b.stdout.as_mut().unwrap();

    write_msg_with_id(a_in, Some(21), create(&projects[0]));
    let (id, response) = read_msg_with_id(a_out);
    assert_eq!(id, Some(21));
    let ServerResponse::CreateTaskOk(task) = response else {
        panic!("expected CreateTaskOk, got: {response:?}");
    };
    assert_eq!(task.id, 1);
    assert_eq!(task.project_path, canonical(&projects[0]));
    // The writer hears of its own change too, after its reply.
    assert_eq!(read_msg_with_id(a_out), (None, changed(&projects[0])));
    assert_eq!(read_msg_with_id(b_out), (None, changed(&projects[0])));

    write_msg_with_id(
        a_in,
        Some(22),
        ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
            project_path: projects[0].path().to_string_lossy().into_owned(),
            task_id: 1,
            event: TaskTransition::ManualMove(TaskStatus::Queue),
            guard: Default::default(),
            update: None,
            comment: None,
        }),
    );
    let (id, response) = read_msg_with_id(a_out);
    assert_eq!(id, Some(22));
    match response {
        ServerResponse::ApplyTaskTransitionOk(applied) => {
            assert_eq!(applied.task.expect("applied").status, TaskStatus::Queue)
        }
        other => panic!("expected ApplyTaskTransitionOk, got: {other:?}"),
    }
    assert_eq!(read_msg_with_id(a_out), (None, changed(&projects[0])));
    assert_eq!(read_msg_with_id(b_out), (None, changed(&projects[0])));

    let b_in = b.stdin.as_mut().unwrap();
    write_msg_with_id(
        b_in,
        Some(31),
        ServerRequest::ListTasks(ProjectRef {
            project_path: canonical(&projects[0]),
        }),
    );
    let (id, response) = read_msg_with_id(b_out);
    assert_eq!(id, Some(31));
    match response {
        ServerResponse::ListTasksOk(listed) => {
            assert_eq!(listed.tasks.len(), 1);
            assert_eq!(listed.tasks[0].id, 1);
            assert_eq!(listed.tasks[0].status, TaskStatus::Queue);
        }
        other => panic!("expected ListTasksOk, got: {other:?}"),
    }

    write_msg_with_id(b_in, Some(32), create(&projects[1]));
    let (id, response) = read_msg_with_id(b_out);
    assert_eq!(id, Some(32));
    match response {
        ServerResponse::CreateTaskOk(task) => assert_eq!(task.id, 1, "ids are per project"),
        other => panic!("expected CreateTaskOk, got: {other:?}"),
    }
    assert_eq!(read_msg_with_id(a_out), (None, changed(&projects[1])));

    for mut child in [a, b] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A prompt one window saves is announced to the other, under the path the daemon resolved.
#[test]
fn test_prompt_changes_reach_every_window() {
    use maestro_protocol::{CreatePromptRequest, ProjectRef};

    let daemon = Daemon::new();
    let mut a = daemon.attach();
    let mut b = daemon.attach();
    let project = tempfile::tempdir().expect("tempdir");
    let canonical = {
        let path = std::fs::canonicalize(project.path()).unwrap();
        let path = path.to_string_lossy().replace('\\', "/");
        path.strip_prefix("//?/").unwrap_or(&path).to_string()
    };
    let changed = || {
        ServerResponse::PromptsChanged(ProjectRef {
            project_path: canonical.clone(),
        })
    };

    let (a_in, a_out) = (a.stdin.as_mut().unwrap(), a.stdout.as_mut().unwrap());
    let b_out = b.stdout.as_mut().unwrap();

    write_msg_with_id(
        a_in,
        Some(41),
        ServerRequest::CreatePrompt(CreatePromptRequest {
            project_path: format!("{}/", project.path().to_string_lossy()),
            title: "Review".to_string(),
            body: "Review the diff".to_string(),
            tags: vec!["Review".to_string()],
            favorite: true,
        }),
    );
    let (id, response) = read_msg_with_id(a_out);
    assert_eq!(id, Some(41));
    let ServerResponse::CreatePromptOk(prompt) = response else {
        panic!("expected CreatePromptOk, got: {response:?}");
    };
    assert_eq!((prompt.id, prompt.favorite), (1, true));
    assert_eq!(prompt.project_path, canonical);
    assert_eq!(prompt.tags, vec!["review".to_string()]);
    assert_eq!(read_msg_with_id(a_out), (None, changed()));
    assert_eq!(read_msg_with_id(b_out), (None, changed()));

    for mut child in [a, b] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// An app's rows go in once, in chunks, under the path the daemon resolved and with their ids,
/// and a second import for the same project is refused without a push.
#[test]
fn test_import_project_over_the_wire() {
    use maestro_protocol::{
        BeginImportRequest, ImportChunkRequest, ImportProjectRequest, ImportProjectResponse,
        ImportRef, ProjectRef,
    };

    let daemon = Daemon::new();
    let mut a = daemon.attach();
    let project = tempfile::tempdir().expect("tempdir");
    let canonical = {
        let path = std::fs::canonicalize(project.path()).unwrap();
        let path = path.to_string_lossy().replace('\\', "/");
        path.strip_prefix("//?/").unwrap_or(&path).to_string()
    };
    let task: maestro_protocol::Task = serde_json::from_value(serde_json::json!({
        "id": 5, "project_path": "/elsewhere", "title": "Kept id", "status": "Review",
        "priority": "Medium", "base_branch": "main", "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z", "auto_approve": false,
        "workspace_mode": "NewWorktree", "workspace_branch_mode": "Create", "ball": "None",
        "review_rounds": 0, "fix_rounds": 0
    }))
    .expect("a task");
    let project_path = format!("{}/", project.path().to_string_lossy());
    let project_ref = || ProjectRef {
        project_path: canonical.clone(),
    };

    let (a_in, a_out) = (a.stdin.as_mut().unwrap(), a.stdout.as_mut().unwrap());
    // Begin, three chunks of one task each, commit: the reply to the commit, under `id`.
    let import =
        |a_in: &mut std::process::ChildStdin, a_out: &mut std::process::ChildStdout, id: u64| {
            write_msg_with_id(
                a_in,
                Some(id),
                ServerRequest::BeginImport(BeginImportRequest {
                    project_path: project_path.clone(),
                    floors: Default::default(),
                    source_id: Some("install-a".to_string()),
                }),
            );
            let import_id = match read_msg_with_id(a_out) {
                (Some(got), ServerResponse::BeginImportOk(begun)) if got == id => {
                    if begun.imported_before {
                        let refused = ImportProjectResponse { imported: false };
                        return (Some(id), ServerResponse::ImportProjectOk(refused));
                    }
                    begun.import_id
                }
                other => panic!("expected BeginImportOk, got: {other:?}"),
            };
            for n in 0..3 {
                let mut chunk_task = task.clone();
                chunk_task.id = 5 + n;
                write_msg_with_id(
                    a_in,
                    Some(id),
                    ServerRequest::ImportChunk(ImportChunkRequest {
                        import_id: import_id.clone(),
                        chunk: ImportProjectRequest {
                            project_path: "ignored".to_string(),
                            tasks: vec![chunk_task],
                            ..ImportProjectRequest::default()
                        },
                    }),
                );
                assert_eq!(
                    read_msg_with_id(a_out),
                    (Some(id), ServerResponse::ImportChunkOk)
                );
            }
            write_msg_with_id(
                a_in,
                Some(id),
                ServerRequest::CommitImport(ImportRef { import_id }),
            );
            read_msg_with_id(a_out)
        };

    assert_eq!(
        import(a_in, a_out, 51),
        (
            Some(51),
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        )
    );
    for push in [
        ServerResponse::TasksChanged(project_ref()),
        ServerResponse::WorktreesChanged(project_ref()),
        ServerResponse::PromptsChanged(project_ref()),
    ] {
        assert_eq!(read_msg_with_id(a_out), (None, push));
    }

    assert_eq!(
        import(a_in, a_out, 52),
        (
            Some(52),
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: false })
        )
    );
    // A commit naming nothing staged is refused.
    write_msg_with_id(
        a_in,
        Some(53),
        ServerRequest::CommitImport(ImportRef {
            import_id: "nothing".to_string(),
        }),
    );
    assert!(matches!(
        read_msg_with_id(a_out),
        (Some(53), ServerResponse::Error(_))
    ));
    // Straight to the next reply: the refusals pushed nothing.
    write_msg_with_id(a_in, Some(54), ServerRequest::ListTasks(project_ref()));
    let (id, response) = read_msg_with_id(a_out);
    assert_eq!(id, Some(54));
    match response {
        ServerResponse::ListTasksOk(listed) => {
            let ids: Vec<i32> = listed.tasks.iter().map(|task| task.id).collect();
            assert_eq!(ids.len(), 3, "{ids:?}");
            assert!([5, 6, 7].iter().all(|id| ids.contains(id)), "{ids:?}");
            assert!(listed
                .tasks
                .iter()
                .all(|task| task.project_path == canonical));
        }
        other => panic!("expected ListTasksOk, got: {other:?}"),
    }

    let _ = a.kill();
    let _ = a.wait();
}
