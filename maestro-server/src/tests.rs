//! Unit tests for maestro-server: SERVER-01 through SERVER-04 behavioral coverage.
//!
//! These tests verify protocol serialization, type construction, and data structure
//! behavior. Full end-to-end integration (live ACP agent subprocess) is covered by
//! manual verification documented in VALIDATION.md.

use maestro_protocol::{
    read_message, write_message, MaestroRpcMessage, PermissionRequest as ProtocolPermissionRequest,
    PermissionResponse, ServerRequest, ServerResponse, SessionUpdate, TerminalOutput,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use tokio::sync::oneshot;

/// SERVER-01 / SERVER-04: PermitResponse variant on ServerRequest roundtrips correctly
/// via serde AND through the length-prefixed wire framing.
/// Verifies that the Tauri host can send PermitResponse to maestro-server and it
/// deserializes to the correct variant with all fields intact.
#[tokio::test]
async fn test_permit_response_roundtrip() {
    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id: "sess-1".to_string(),
        request_id: "perm-42".to_string(),
        option_id: Some("default".into()),
    }));

    // JSON serde roundtrip
    let json = serde_json::to_string(&msg).unwrap();
    assert!(
        json.contains("permit_response"),
        "JSON must contain 'permit_response' type tag"
    );
    let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, back);

    // Wire framing roundtrip (length-prefixed)
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let framed_back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, framed_back);

    // Also test option_id=None (cancelled)
    let msg_cancel =
        MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-2".to_string(),
            request_id: "perm-99".to_string(),
            option_id: None,
        }));
    let json_cancel = serde_json::to_string(&msg_cancel).unwrap();
    let back_cancel: MaestroRpcMessage = serde_json::from_str(&json_cancel).unwrap();
    assert_eq!(msg_cancel, back_cancel);
}

/// SERVER-02: SessionUpdate ServerResponse serializes correctly with arbitrary
/// JSON payload (representing ACP SessionNotification).
/// Verifies that session_notification callback output would produce a valid wire frame.
#[tokio::test]
async fn test_session_notification_writes_stdout() {
    // Simulate what MaestroServerClient::session_notification produces:
    // a ServerResponse::SessionUpdate with the session_id and serialized payload
    let payload = serde_json::json!({
        "session_id": "acp-sess-abc",
        "update": {
            "type": "agent_message_chunk",
            "text": "Hello from the agent"
        }
    });

    let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
        session_id: "maestro-sess-1".to_string(),
        payload: payload.clone(),
    }));

    // Write to buffer (simulating stdout write)
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    assert!(!buf.is_empty(), "write_message must produce bytes");

    // Read back and verify
    let mut cursor = std::io::Cursor::new(buf);
    let back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, back);

    // Verify the payload is preserved exactly
    if let MaestroRpcMessage::Response(ServerResponse::SessionUpdate(update)) = back {
        assert_eq!(update.session_id, "maestro-sess-1");
        assert_eq!(update.payload, payload);
    } else {
        panic!("Expected SessionUpdate response");
    }
}

/// SERVER-03: TerminalOutput ServerResponse frame serializes correctly with
/// binary bytes payload.
/// Verifies that create_terminal's background reader would produce valid wire frames.
#[tokio::test]
async fn test_terminal_output_frame() {
    let terminal_bytes = b"$ cargo build\nCompiling maestro v0.1.0\n".to_vec();

    let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
        session_id: "maestro-sess-1".to_string(),
        terminal_id: "term-1".to_string(),
        bytes: terminal_bytes.clone(),
    }));

    // Wire framing roundtrip
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, back);

    // Verify bytes preserved
    if let MaestroRpcMessage::Response(ServerResponse::TerminalOutput(output)) = back {
        assert_eq!(output.bytes, terminal_bytes);
        assert_eq!(output.terminal_id, "term-1");
        assert_eq!(output.session_id, "maestro-sess-1");
    } else {
        panic!("Expected TerminalOutput response");
    }

    // Test with ANSI escape codes (real terminal output)
    let ansi_bytes = vec![
        0x1b, 0x5b, 0x33, 0x32, 0x6d, b'O', b'K', 0x1b, 0x5b, 0x30, 0x6d,
    ];
    let msg_ansi = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
        session_id: "sess-2".to_string(),
        terminal_id: "term-2".to_string(),
        bytes: ansi_bytes.clone(),
    }));
    let mut buf2: Vec<u8> = Vec::new();
    write_message(&mut buf2, &msg_ansi).await.unwrap();
    let mut cursor2 = std::io::Cursor::new(buf2);
    let back2 = read_message(&mut cursor2).await.unwrap();
    assert_eq!(msg_ansi, back2);
}

/// SERVER-04: Permission request/response correlation via pending_permissions map.
/// Verifies that inserting a oneshot sender and resolving it simulates the
/// request_permission -> PermitResponse -> oneshot dispatch flow.
#[tokio::test]
async fn test_permission_pause_creates_pending_entry() {
    // Simulate the pending_permissions map from MaestroServerClient (bool matches client.rs)
    let pending: Rc<RefCell<HashMap<String, oneshot::Sender<bool>>>> =
        Rc::new(RefCell::new(HashMap::new()));

    // Simulate request_permission: create channel, insert sender
    let (tx, rx) = oneshot::channel::<bool>();
    let request_id = "perm-42".to_string();
    pending.borrow_mut().insert(request_id.clone(), tx);

    // Verify entry exists
    assert!(pending.borrow().contains_key("perm-42"));
    assert_eq!(pending.borrow().len(), 1);

    // Simulate PermitResponse dispatch from stdin loop: remove sender, send response
    let sender = pending.borrow_mut().remove(&request_id).unwrap();
    assert!(pending.borrow().is_empty(), "sender removed after dispatch");

    // Send allowed=true (simulating the stdin loop resolving the oneshot)
    sender.send(true).unwrap();

    // Receive on the other end (simulating request_permission unblocking)
    let result = rx.await.unwrap();
    assert!(result, "expected allowed=true");

    // Also test the PermissionRequest ServerResponse wire format (what request_permission writes)
    let perm_req_msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(
        ProtocolPermissionRequest {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            payload: serde_json::json!({"tool": "write_file", "path": "/tmp/test.rs"}),
        },
    ));
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &perm_req_msg).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let back = read_message(&mut cursor).await.unwrap();
    assert_eq!(perm_req_msg, back);
}

/// A session idle across two sweeps with nobody attached is closed; anything else is left alone.
#[tokio::test]
async fn test_reap_closes_only_idle_unwatched_sessions() {
    use crate::sessions::{ActiveSession, SessionMap};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn session(
        turn_active: bool,
    ) -> (
        ActiveSession,
        tokio::sync::mpsc::Receiver<crate::SessionCommand>,
    ) {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(4);
        let session = ActiveSession {
            cmd_tx,
            pending_permissions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            task: tokio::spawn(async {}),
            cleanup: None,
            agent_id: "agent".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            host_meta: None,
            turn_active: Arc::new(AtomicBool::new(turn_active)),
            idle_marked: false,
        };
        (session, cmd_rx)
    }

    let attached = crate::client_sink::ClientSink::stdio();
    let detached = crate::client_sink::ClientSink::detached();

    let mut sessions: SessionMap = HashMap::new();
    let (idle, mut idle_rx) = session(false);
    let (busy, _busy_rx) = session(true);
    sessions.insert("idle".to_string(), idle);
    sessions.insert("busy".to_string(), busy);

    // Somebody is watching: nothing is idle, whatever the turn state or how long it lasts.
    crate::reap_idle_sessions(&mut sessions, &attached).await;
    crate::reap_idle_sessions(&mut sessions, &attached).await;
    assert_eq!(sessions.len(), 2);
    assert!(!sessions["idle"].idle_marked);

    // Nobody watching: the idle one is marked, the mid-turn one is not.
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert_eq!(sessions.len(), 2, "one sweep marks, it does not close");
    assert!(sessions["idle"].idle_marked);
    assert!(!sessions["busy"].idle_marked);

    // Marked, and still idle on the next sweep.
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert_eq!(sessions.len(), 1, "the idle session is gone");
    assert!(sessions.contains_key("busy"));
    assert!(
        matches!(
            idle_rx.recv().await,
            Some(crate::SessionCommand::CloseSession)
        ),
        "the agent is asked to close the session, not left holding it"
    );

    // A turn that ends while nobody is attached is marked by the next sweep, not closed by it.
    sessions["busy"].turn_active.store(false, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert_eq!(sessions.len(), 1);
    assert!(sessions["busy"].idle_marked);
}

/// Activity between two sweeps clears the mark, so the grace period starts over.
#[tokio::test]
async fn test_reap_mark_is_cleared_by_activity() {
    use crate::sessions::{ActiveSession, SessionMap};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let (cmd_tx, _cmd_rx) = tokio::sync::mpsc::channel(4);
    let turn_active = Arc::new(AtomicBool::new(false));
    let mut sessions: SessionMap = HashMap::new();
    sessions.insert(
        "session".to_string(),
        ActiveSession {
            cmd_tx,
            pending_permissions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            task: tokio::spawn(async {}),
            cleanup: None,
            agent_id: "agent".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            host_meta: None,
            turn_active: Arc::clone(&turn_active),
            idle_marked: false,
        },
    );

    let detached = crate::client_sink::ClientSink::detached();
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert!(sessions["session"].idle_marked);

    // A turn starts before the sweep that would have closed it.
    turn_active.store(true, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert_eq!(sessions.len(), 1, "the mark is cancelled, not honoured");
    assert!(!sessions["session"].idle_marked);

    // The turn ends, and the whole grace period runs again from there.
    turn_active.store(false, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert_eq!(sessions.len(), 1);
    crate::reap_idle_sessions(&mut sessions, &detached).await;
    assert!(sessions.is_empty());
}
