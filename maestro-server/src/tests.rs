//! Tests of the main loop's session bookkeeping: the idle sweep, listing a project's running
//! sessions, and taking a session that has just come up into the map.

use std::collections::HashMap;

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
        tokio::sync::mpsc::Receiver<crate::sessions::SessionCommand>,
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
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &attached, None, None).await;
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &attached, None, None).await;
    assert_eq!(sessions.len(), 2);
    assert!(!sessions["idle"].idle_marked);

    // Nobody watching: the idle one is marked, the mid-turn one is not.
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
    assert_eq!(sessions.len(), 2, "one sweep marks, it does not close");
    assert!(sessions["idle"].idle_marked);
    assert!(!sessions["busy"].idle_marked);

    // Marked, and still idle on the next sweep.
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
    assert_eq!(sessions.len(), 1, "the idle session is gone");
    assert!(sessions.contains_key("busy"));
    assert!(
        matches!(
            idle_rx.recv().await,
            Some(crate::sessions::SessionCommand::CloseSession)
        ),
        "the agent is asked to close the session, not left holding it"
    );

    // A turn that ends while nobody is attached is marked by the next sweep, not closed by it.
    sessions["busy"].turn_active.store(false, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
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
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
    assert!(sessions["session"].idle_marked);

    // A turn starts before the sweep that would have closed it.
    turn_active.store(true, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
    assert_eq!(sessions.len(), 1, "the mark is cancelled, not honoured");
    assert!(!sessions["session"].idle_marked);

    // The turn ends, and the whole grace period runs again from there.
    turn_active.store(false, Ordering::SeqCst);
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
    assert_eq!(sessions.len(), 1);
    crate::reap_idle_sessions(&mut sessions, &no_agents(), &detached, None, None).await;
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
            Some(crate::sessions::SessionCommand::CloseSession)
        ),
        "the agent is asked to close it"
    );
}

fn no_agents() -> crate::sessions::SharedAgentConnections {
    std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::sessions::AgentConnectionMap::new(),
    ))
}
