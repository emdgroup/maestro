/// Integration tests for maestro-server binary via stdin/stdout pipe.
///
/// Spawns the actual binary and communicates using the maestro-protocol wire format
/// (4-byte LE length prefix + JSON body). Tests the error paths that don't require
/// a real ACP agent subprocess, verifying:
///
/// - Protocol framing works end-to-end (client write → server read → server write → client read)
/// - SpawnRequest with unknown agent returns a structured Error response (not a hang or crash)
/// - PromptRequest for an unknown session returns Error "unknown session: ..."
/// - PermitResponse/Cancel for unknown sessions are silently ignored (no crash, no response)
/// - Server exits cleanly when stdin closes (EOF)
///
/// Happy-path tests (successful spawn + forwarded prompt + unblocked permission) require
/// a live ACP agent subprocess and are covered by manual verification in VALIDATION.md.
///
/// Timeout strategy: tests expecting a response block on read_exact (server MUST respond).
/// Tests expecting NO response close stdin, wait for server exit, then assert stdout was empty.
/// This avoids needing set_read_timeout (unavailable on ChildStdout).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use maestro_protocol::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    SpawnRequest, PromptRequest, CancelRequest, PermissionResponse, ListAgentsRequest,
};

fn server_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join("target/debug/maestro-server")
}

fn write_msg(writer: &mut impl Write, msg: &MaestroRpcMessage) {
    let body = serde_json::to_vec(msg).expect("serialize");
    let len = body.len() as u32;
    writer.write_all(&len.to_le_bytes()).expect("write len");
    writer.write_all(&body).expect("write body");
    writer.flush().expect("flush");
}

fn read_msg(reader: &mut impl Read) -> MaestroRpcMessage {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).expect("read len prefix");
    let len = u32::from_le_bytes(len_buf) as usize;
    assert!(len < 16 * 1024 * 1024, "response too large: {} bytes", len);
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).expect("read body");
    serde_json::from_slice(&body).expect("deserialize response")
}

fn spawn_server() -> std::process::Child {
    let bin = server_binary();
    assert!(
        bin.exists(),
        "maestro-server binary not found at {:?} — run `cargo build -p maestro-server` first",
        bin
    );
    Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn maestro-server")
}

/// SpawnRequest with a nonexistent agent_id must return ServerResponse::Error.
/// Proves protocol framing works end-to-end and the Spawn handler rejects gracefully.
#[test]
fn test_spawn_unknown_agent_returns_error() {
    let mut child = spawn_server();
    let stdin = child.stdin.as_mut().unwrap();
    let stdout = child.stdout.as_mut().unwrap();

    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: "nonexistent-acp-agent-xyz-12345".to_string(),
        session_id: "session-1".to_string(),
        cwd: "/tmp".to_string(),
    })));

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
        other => panic!("expected Error response, got: {}", serde_json::to_string(&other).unwrap()),
    }

    let _ = child.kill();
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

    // Step 1: failed spawn — consume Error
    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: "no-such-agent".to_string(),
        session_id: "session-99".to_string(),
        cwd: "/tmp".to_string(),
    })));
    let spawn_resp = read_msg(stdout);
    assert!(
        matches!(spawn_resp, MaestroRpcMessage::Response(ServerResponse::Error(_))),
        "expected Error from failed spawn, got: {}",
        serde_json::to_string(&spawn_resp).unwrap()
    );

    // Step 2: prompt on the never-registered session
    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: "session-99".to_string(),
        content: serde_json::Value::String("hello world".to_string()),
    })));
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
}

/// PermitResponse for an unknown session must be silently ignored.
/// Approach: close stdin after sending, drain stdout to EOF, assert nothing was written.
#[test]
fn test_permit_response_unknown_session_produces_no_output() {
    let mut child = spawn_server();

    {
        let stdin = child.stdin.as_mut().unwrap();
        write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "session-never".to_string(),
            request_id: "perm-001".to_string(),
            option_id: Some("default".into()),
        })));
        // Drop stdin here (end of scope) — causes server to receive EOF and exit
    }
    drop(child.stdin.take());

    // Read all stdout until EOF (server has exited)
    let mut output = Vec::new();
    child.stdout.as_mut().unwrap().read_to_end(&mut output).expect("drain stdout");
    let _ = child.wait();

    assert!(
        output.is_empty(),
        "server must produce no output for PermitResponse to unknown session, got {} bytes",
        output.len()
    );
}

/// Cancel for an unknown session must be silently ignored with no output.
#[test]
fn test_cancel_unknown_session_produces_no_output() {
    let mut child = spawn_server();

    {
        let stdin = child.stdin.as_mut().unwrap();
        write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest {
            session_id: "session-ghost".to_string(),
        })));
    }
    drop(child.stdin.take());

    let mut output = Vec::new();
    child.stdout.as_mut().unwrap().read_to_end(&mut output).expect("drain stdout");
    let _ = child.wait();

    assert!(
        output.is_empty(),
        "server must produce no output for Cancel of unknown session, got {} bytes",
        output.len()
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

    // Consume spawn error first
    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: "no-agent".to_string(),
        session_id: "session-large".to_string(),
        cwd: "/tmp".to_string(),
    })));
    let _ = read_msg(stdout);

    // 64 KB prompt
    let large_content = serde_json::Value::String("x".repeat(64 * 1024));
    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: "session-large".to_string(),
        content: large_content,
    })));

    let resp = read_msg(stdout);
    assert!(
        matches!(resp, MaestroRpcMessage::Response(ServerResponse::Error(_))),
        "large payload must still produce a parseable Error response"
    );

    let _ = child.kill();
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

    write_msg(stdin, &MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {})));

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
}
