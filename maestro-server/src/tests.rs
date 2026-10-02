//! Unit tests for maestro-server: SERVER-01 through SERVER-04 behavioral coverage.
//!
//! These tests verify protocol serialization, type construction, and data structure
//! behavior. Full end-to-end integration (live ACP agent subprocess) is covered by
//! manual verification documented in VALIDATION.md.

use maestro_protocol::{
    read_message, write_message, PermissionRequest as ProtocolPermissionRequest,
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
    let msg = ServerRequest::PermitResponse(PermissionResponse {
        session_id: "sess-1".to_string(),
        request_id: "perm-42".to_string(),
        option_id: Some("default".into()),
    });

    // JSON serde roundtrip
    let json = serde_json::to_string(&msg).unwrap();
    assert!(
        json.contains("permit_response"),
        "JSON must contain 'permit_response' type tag"
    );
    let back: ServerRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(msg, back);

    // Wire framing roundtrip (length-prefixed)
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let framed_back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, framed_back);

    // Also test option_id=None (cancelled)
    let msg_cancel = ServerRequest::PermitResponse(PermissionResponse {
        session_id: "sess-2".to_string(),
        request_id: "perm-99".to_string(),
        option_id: None,
    });
    let json_cancel = serde_json::to_string(&msg_cancel).unwrap();
    let back_cancel: ServerRequest = serde_json::from_str(&json_cancel).unwrap();
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

    let msg = ServerResponse::SessionUpdate(SessionUpdate {
        session_id: "maestro-sess-1".to_string(),
        payload: payload.clone(),
    });

    // Write to buffer (simulating stdout write)
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    assert!(!buf.is_empty(), "write_message must produce bytes");

    // Read back and verify
    let mut cursor = std::io::Cursor::new(buf);
    let back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, back);

    // Verify the payload is preserved exactly
    if let ServerResponse::SessionUpdate(update) = back {
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

    let msg = ServerResponse::TerminalOutput(TerminalOutput {
        session_id: "maestro-sess-1".to_string(),
        terminal_id: "term-1".to_string(),
        bytes: terminal_bytes.clone(),
    });

    // Wire framing roundtrip
    let mut buf: Vec<u8> = Vec::new();
    write_message(&mut buf, &msg).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let back = read_message(&mut cursor).await.unwrap();
    assert_eq!(msg, back);

    // Verify bytes preserved
    if let ServerResponse::TerminalOutput(output) = back {
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
    let msg_ansi = ServerResponse::TerminalOutput(TerminalOutput {
        session_id: "sess-2".to_string(),
        terminal_id: "term-2".to_string(),
        bytes: ansi_bytes.clone(),
    });
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
    let perm_req_msg = ServerResponse::PermissionRequest(ProtocolPermissionRequest {
        session_id: "sess-1".to_string(),
        request_id: "perm-42".to_string(),
        payload: serde_json::json!({"tool": "write_file", "path": "/tmp/test.rs"}),
    });
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
            project: None,
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
    crate::reap_idle_sessions(&mut sessions, &attached, None, None).await;
    crate::reap_idle_sessions(&mut sessions, &attached, None, None).await;
    assert_eq!(sessions.len(), 2);
    assert!(!sessions["idle"].idle_marked);

    // Nobody watching: the idle one is marked, the mid-turn one is not.
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
    assert_eq!(sessions.len(), 2, "one sweep marks, it does not close");
    assert!(sessions["idle"].idle_marked);
    assert!(!sessions["busy"].idle_marked);

    // Marked, and still idle on the next sweep.
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
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
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
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
            project: None,
            turn_active: Arc::clone(&turn_active),
            idle_marked: false,
        },
    );

    let detached = crate::client_sink::ClientSink::detached();
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
    assert!(sessions["session"].idle_marked);

    // A turn starts before the sweep that would have closed it.
    turn_active.store(true, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
    assert_eq!(sessions.len(), 1, "the mark is cancelled, not honoured");
    assert!(!sessions["session"].idle_marked);

    // The turn ends, and the whole grace period runs again from there.
    turn_active.store(false, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
    assert_eq!(sessions.len(), 1);
    crate::reap_idle_sessions(&mut sessions, &detached, None, None).await;
    assert!(sessions.is_empty());
}

fn project_session(
    agent_id: &str,
    acp_session_id: &str,
    project_path: &str,
    task: tokio::task::JoinHandle<()>,
) -> crate::sessions::ActiveSession {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    let (cmd_tx, _cmd_rx) = tokio::sync::mpsc::channel(4);
    crate::sessions::ActiveSession {
        cmd_tx,
        pending_permissions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        pending_elicitations: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        task,
        cleanup: Some(crate::sessions::SessionCleanup {
            acp_session_id: acp_session_id.to_string(),
            router: Arc::new(crate::sessions::SessionRouter::default()),
        }),
        agent_id: agent_id.to_string(),
        cwd: format!("{project_path}/work"),
        additional_directories: Vec::new(),
        project: Some(crate::sessions::ProjectBinding {
            project_path: project_path.to_string(),
            meta: maestro_protocol::SessionMeta {
                task_id: Some(3),
                ..Default::default()
            },
            can_reload: true,
            requested_at: chrono::Utc::now(),
        }),
        turn_active: Arc::new(AtomicBool::new(false)),
        idle_marked: false,
    }
}

/// With no store, a project's running sessions are still listed, from the map, and nothing else.
#[tokio::test]
async fn test_running_project_sessions_lists_only_that_projects_live_sessions() {
    let mut sessions: crate::sessions::SessionMap = HashMap::new();
    let pending = || tokio::spawn(std::future::pending::<()>());
    sessions.insert(
        "mine".to_string(),
        project_session("claude", "a", "/p", pending()),
    );
    sessions.insert(
        "theirs".to_string(),
        project_session("claude", "b", "/q", pending()),
    );
    let mut unbound = project_session("claude", "c", "/p", pending());
    unbound.project = None;
    sessions.insert("unbound".to_string(), unbound);

    let rows = crate::dispatch::running_project_sessions(&sessions, "/p");
    assert_eq!(rows.len(), 1);
    let (row, session_id) = &rows[0];
    assert_eq!(row.acp_session_id, "a");
    assert_eq!(row.meta.task_id, Some(3));
    assert!(!row.closed);
    assert_eq!(session_id.as_deref(), Some("mine"));
}

/// A map entry whose command loop has ended does not keep a conversation's row open.
#[tokio::test]
async fn test_close_guard_ignores_a_finished_command_loop() {
    let mut sessions: crate::sessions::SessionMap = HashMap::new();
    sessions.insert(
        "running".to_string(),
        project_session(
            "claude",
            "a",
            "/p",
            tokio::spawn(std::future::pending::<()>()),
        ),
    );
    let finished = tokio::spawn(async {});
    while !finished.is_finished() {
        tokio::task::yield_now().await;
    }
    sessions.insert(
        "finished".to_string(),
        project_session("claude", "b", "/p", finished),
    );

    assert!(crate::dispatch::runs_under_key(&sessions, "claude", "a"));
    assert!(!crate::dispatch::runs_under_key(&sessions, "claude", "b"));
    assert!(!crate::dispatch::runs_under_key(&sessions, "other", "a"));
}

/// A session whose row was closed while it came up is closed, not kept where nobody owns it.
#[tokio::test]
async fn test_a_session_closed_while_it_came_up_is_closed_not_kept() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store: crate::project_store::Store = std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open(dir.path()).expect("store"),
    ));
    let agent_connections: crate::sessions::SharedAgentConnections = std::sync::Arc::new(
        tokio::sync::Mutex::new(crate::sessions::AgentConnectionMap::new()),
    );
    let stdout = crate::client_sink::ClientSink::detached();
    let mut sessions: crate::sessions::SessionMap = HashMap::new();

    let started = |acp_session_id: &str| {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(4);
        let mut session = project_session(
            "claude",
            acp_session_id,
            "/p",
            tokio::spawn(std::future::pending::<()>()),
        );
        session.cmd_tx = cmd_tx;
        if let Some(project) = session.project.as_mut() {
            project.requested_at = chrono::Utc::now() - chrono::Duration::seconds(5);
        }
        (session, cmd_rx)
    };

    // Positive control: an open row keeps its session.
    let (open, _open_rx) = started("a");
    crate::register_started_session(
        "live-1".to_string(),
        open,
        &mut sessions,
        &agent_connections,
        Some(&store),
        None,
        &stdout,
    )
    .await;
    assert!(sessions.contains_key("live-1"));

    // It goes dormant, is loaded again, and the user closes it while that load is in flight.
    sessions.remove("live-1");
    crate::project_store::go_dormant(&*store.lock().await, "live-1", chrono::Utc::now())
        .expect("dormant");
    crate::project_store::close_dormant(&*store.lock().await, "claude", "a", chrono::Utc::now())
        .expect("close");
    let (gone, mut gone_rx) = started("a");
    crate::register_started_session(
        "live-2".to_string(),
        gone,
        &mut sessions,
        &agent_connections,
        Some(&store),
        None,
        &stdout,
    )
    .await;
    assert!(sessions.is_empty(), "nobody would own it");
    assert!(
        matches!(
            gone_rx.recv().await,
            Some(crate::SessionCommand::CloseSession)
        ),
        "the agent is asked to close it"
    );
}
