use maestro_protocol::{TaskStatus, WorkspaceMode};
use serde_json::json;

use super::prompt_tools::NO_WINDOW;
use super::task_tools::NOT_A_LOOP;
use super::*;

#[tokio::test]
async fn framing_gateway_request_roundtrip() {
    let req = GatewayRequest {
        token: "1cb1f3c8-0000-4000-8000-000000000000".to_string(),
        call: HostToolCall {
            session_id: "session-3".to_string(),
            request_id: "shim".to_string(),
            name: "canvas_await".to_string(),
            arguments: serde_json::json!({"surfaceId": "s1", "timeoutSeconds": 30}),
        },
    };
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_frame(&mut buf, &req).await.unwrap();
    let mut cursor = std::io::Cursor::new(buf);
    let back: GatewayRequest = maestro_protocol::read_frame(&mut cursor).await.unwrap();
    assert_eq!(req, back);
}

fn pending_with(
    entries: &[(&str, &str)],
) -> (PendingHostTools, Vec<oneshot::Receiver<HostToolResult>>) {
    let mut pending = PendingHostTools::new();
    let mut receivers = Vec::new();
    for (request_id, session_id) in entries {
        let (tx, rx) = oneshot::channel();
        pending.insert((*request_id).to_string(), ((*session_id).to_string(), tx));
        receivers.push(rx);
    }
    (pending, receivers)
}

fn session_in(project_path: &str, task_id: Option<i32>) -> crate::sessions::ActiveSession {
    let (cmd_tx, _cmd_rx) = mpsc::channel(4);
    crate::sessions::ActiveSession {
        cmd_tx,
        pending_permissions: Default::default(),
        pending_elicitations: Default::default(),
        task: tokio::spawn(async {}),
        cleanup: None,
        agent_id: "agent".to_string(),
        cwd: project_path.to_string(),
        additional_directories: Vec::new(),
        project: Some(crate::sessions::ProjectBinding {
            project_path: project_path.to_string(),
            meta: maestro_protocol::SessionMeta {
                task_id,
                ..Default::default()
            },
            can_reload: false,
            requested_at: chrono::Utc::now(),
        }),
        turn_active: Default::default(),
        idle_marked: false,
    }
}

/// One tool call through the gateway, as the main loop makes it.
async fn call(
    sessions: &SessionMap,
    store: Option<&Store>,
    name: &str,
    arguments: Value,
) -> HostToolResult {
    let (reply_tx, reply_rx) = oneshot::channel();
    let mut pending = PendingHostTools::new();
    let call = HostToolCall {
        session_id: "session".to_string(),
        request_id: "request".to_string(),
        name: name.to_string(),
        arguments,
    };
    let sink = crate::client_sink::ClientSink::detached();
    handle_host_tool_call(call, reply_tx, sessions, store, None, &mut pending, &sink).await;
    assert!(pending.is_empty(), "{name} was forwarded to the host");
    reply_rx.await.expect("an answer")
}

fn ok(result: HostToolResult) -> Value {
    assert_eq!(result.error, None);
    result.result
}

#[tokio::test]
async fn task_tools_are_answered_from_the_store() {
    let project = tempfile::tempdir().expect("project dir");
    std::fs::create_dir(project.path().join(".maestro")).expect(".maestro");
    std::fs::write(
        project.path().join(".maestro/settings.json"),
        r#"{"base_branch":"develop","default_workspace_mode":"RepositoryDirectory"}"#,
    )
    .expect("settings");
    let project_path = project.path().to_string_lossy().into_owned();
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    // The first task a project mints is 1: the session was started for the one created below.
    sessions.insert("session".to_string(), session_in(&project_path, Some(1)));
    let answered_by = Some(&store);

    let created = ok(call(
        &sessions,
        answered_by,
        "create_task",
        json!({ "title": "  Fix the thing  ", "priority": "High", "labels": ["bug"] }),
    )
    .await);
    assert_eq!(
        created,
        json!({ "id": 1, "title": "Fix the thing", "status": "Planning", "runMode": "Pipeline" })
    );

    let listed = ok(call(&sessions, answered_by, "list_tasks", json!({})).await);
    assert_eq!(
        listed,
        json!({ "tasks": [{ "id": 1, "title": "Fix the thing", "status": "Planning",
                            "priority": "High", "labels": ["bug"] }] })
    );
    let none = ok(call(
        &sessions,
        answered_by,
        "list_tasks",
        json!({ "status": "Done" }),
    )
    .await);
    assert_eq!(none, json!({ "tasks": [] }));

    let updated = ok(call(
        &sessions,
        answered_by,
        "update_task",
        json!({ "id": 1, "status": "InProgress", "priority": "Low" }),
    )
    .await);
    assert_eq!(updated["status"], "InProgress");
    assert_eq!(updated["priority"], "Low");

    let comment = ok(call(
        &sessions,
        answered_by,
        "comment_task",
        json!({ "body": " tried X, it did not work " }),
    )
    .await);
    assert_eq!(comment["taskId"], 1);

    // No id: the session's own task.
    let task = ok(call(&sessions, answered_by, "get_task", json!({})).await);
    assert_eq!(task["id"], 1);
    assert_eq!(task["status"], "InProgress");
    assert_eq!(task["baseBranch"], "develop");
    let thread = task["thread"].as_array().expect("thread");
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0]["kind"], "note");
    assert_eq!(thread[0]["author"], "agent");
    assert_eq!(thread[0]["body"], "tried X, it did not work");

    let stored = crate::task_store::list(
        &*store.lock().await,
        &crate::project_path::canonical_project_path(&project_path),
    )
    .expect("list");
    assert_eq!(stored[0].workspace_mode, WorkspaceMode::RepositoryDirectory);
}

#[tokio::test]
async fn a_loop_is_drafted_and_its_worker_gets_the_loop_tools_only() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let canonical = crate::project_path::canonical_project_path(&project_path);
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut plain = SessionMap::new();
    plain.insert("session".to_string(), session_in(&project_path, None));
    let mut worker = SessionMap::new();
    let mut session = session_in(&project_path, Some(1));
    if let Some(binding) = session.project.as_mut() {
        let role = json!({ "loop": crate::loop_engine::LoopSession::Iteration(1) });
        binding.meta.role = Some(role.to_string());
    }
    worker.insert("session".to_string(), session);
    let shared = store.clone();
    let store = Some(&store);
    let error = |result: HostToolResult| result.error.expect("an error");

    assert_eq!(
        error(
            call(
                &plain,
                store,
                "create_task",
                json!({ "title": "x", "max_iterations": 3 })
            )
            .await
        ),
        NOT_A_LOOP
    );
    let created = ok(call(
        &plain,
        store,
        "create_task",
        json!({
            "title": "Make it pass",
            "run_mode": "Loop",
            "checks": [
                { "kind": "Command", "label": "Tests pass", "command": "cargo test" },
                { "kind": "Judge", "label": "Empty lists are handled" },
            ],
            "max_iterations": 5,
        }),
    )
    .await);
    assert_eq!(created["runMode"], "Loop");
    let task = crate::task_store::get(&*shared.lock().await, &canonical, 1)
        .unwrap()
        .unwrap();
    assert_eq!(task.workspace_mode, WorkspaceMode::NewWorktree);
    assert_eq!(task.loop_config.as_ref().unwrap().max_iterations, 5);

    // Not running yet: the worker's session acts for no iteration.
    assert_eq!(
        error(call(&worker, store, "loop_status", json!({})).await),
        "iteration 1 is over, so this session no longer acts for the loop"
    );
    {
        let conn = shared.lock().await;
        conn.execute(
            "UPDATE tasks SET status = 'InProgress', phase = 'Iterating',
                phase_status = 'Running', ball = 'Agent' WHERE project_path = ?1 AND id = 1",
            [&canonical],
        )
        .unwrap();
        crate::task_store::loops::start_iteration(&conn, &canonical, 1, 1, "acp", "agent").unwrap();
    }

    let status = ok(call(&worker, store, "loop_status", json!({})).await);
    assert_eq!(status["iteration"], 1);
    assert_eq!(status["budget"]["iterationsAfterThis"], 4);
    assert_eq!(status["checks"][0]["label"], "Tests pass");
    assert!(status["checks"][0].get("command").is_none());

    let own = ok(call(&worker, store, "get_task", json!({})).await);
    assert!(own["loop"]["checks"][0].get("command").is_none());
    assert!(own["loop"].get("sealedPaths").is_none());
    let seen = ok(call(&plain, store, "get_task", json!({ "id": 1 })).await);
    assert_eq!(seen["loop"]["checks"][0]["command"], "cargo test");
    assert_eq!(
        error(call(&worker, store, "update_task", json!({ "status": "Done" })).await),
        "a loop's own session cannot change its task"
    );

    for n in 0..3 {
        ok(call(
            &worker,
            store,
            "loop_propose_check",
            json!({ "label": format!("Check {n}"), "why": "because" }),
        )
        .await);
    }
    assert!(error(
        call(
            &worker,
            store,
            "loop_propose_check",
            json!({ "label": "One more" })
        )
        .await
    )
    .contains("3 proposals"));

    ok(call(
        &worker,
        store,
        "loop_blocked",
        json!({ "reason": " Which API key? " }),
    )
    .await);
    let iterations =
        crate::task_store::loops::list_iterations(&*shared.lock().await, &canonical, 1).unwrap();
    assert_eq!(iterations[0].blocked.as_deref(), Some("Which API key?"));

    assert_eq!(
        error(call(&plain, store, "loop_status", json!({})).await),
        "this session is not a loop iteration"
    );
}

#[tokio::test]
async fn task_tools_refuse_what_the_host_refused() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&project_path, None));
    let store = Some(&store);

    let error = |result: HostToolResult| result.error.expect("an error");
    assert_eq!(
        error(call(&sessions, None, "list_tasks", json!({})).await),
        crate::project_store::UNAVAILABLE
    );
    assert_eq!(
        error(call(&sessions, store, "get_task", json!({})).await),
        "this session is not attached to a task — pass an id"
    );
    assert_eq!(
        error(call(&sessions, store, "get_task", json!({ "id": 7 })).await),
        "no task 7 in this project"
    );
    assert!(error(
        call(
            &sessions,
            store,
            "create_task",
            json!({ "title": "Something", "priority": "P1" })
        )
        .await
    )
    .starts_with("unknown priority \"P1\""));

    ok(call(
        &sessions,
        store,
        "create_task",
        json!({ "title": "Something" }),
    )
    .await);
    assert!(error(
        call(
            &sessions,
            store,
            "update_task",
            json!({ "id": 1, "status": "Cancelled" })
        )
        .await
    )
    .starts_with("unknown status \"Cancelled\""));
    assert_eq!(
        error(call(&sessions, store, "update_task", json!({ "id": 1 })).await),
        "nothing to update"
    );
    assert_eq!(
        error(
            call(
                &sessions,
                store,
                "comment_task",
                json!({ "id": 1, "body": "  " })
            )
            .await
        ),
        "body is required"
    );

    // A session with no project is refused before anything else.
    sessions.get_mut("session").expect("session").project = None;
    assert_eq!(
        error(call(&sessions, store, "list_tasks", json!({})).await),
        "this session is not attached to a Maestro project"
    );
}

/// A status from `update_task` is the user dragging the card: it takes the task out of the
/// pipeline rather than leaving a phase claiming an agent is still at work.
#[tokio::test]
async fn update_task_moves_a_task_as_the_user_would() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let canonical = crate::project_path::canonical_project_path(&project_path);
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&project_path, None));

    ok(call(
        &sessions,
        Some(&store),
        "create_task",
        json!({ "title": "Ship it" }),
    )
    .await);
    crate::task_store::transition::apply_transition(
        &mut *store.lock().await,
        &maestro_protocol::ApplyTaskTransitionRequest {
            project_path: canonical.clone(),
            task_id: 1,
            event: maestro_protocol::TaskTransition::SessionReady(
                maestro_protocol::AgentRole::Coder,
            ),
            guard: maestro_protocol::TransitionGuard::Always,
            update: None,
            comment: None,
        },
    )
    .expect("apply")
    .expect("applied");

    let moved = ok(call(
        &sessions,
        Some(&store),
        "update_task",
        json!({ "id": 1, "status": "Review" }),
    )
    .await);
    assert_eq!(moved["status"], "Review");
    let stored = crate::task_store::list(&*store.lock().await, &canonical).expect("list");
    assert_eq!(stored[0].phase, None);
    assert_eq!(stored[0].phase_status, None);
    assert_eq!(stored[0].ball, maestro_protocol::TaskBall::None);
}

/// Ids are small integers per project, so an id from another project must not reach its board.
#[tokio::test]
async fn update_task_refuses_another_projects_task() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let other = tempfile::tempdir().expect("other project dir");
    let other_path = other.path().to_string_lossy().into_owned();
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&other_path, None));
    for title in ["First", "Second"] {
        ok(call(
            &sessions,
            Some(&store),
            "create_task",
            json!({ "title": title }),
        )
        .await);
    }
    sessions.insert("session".to_string(), session_in(&project_path, None));

    let refused = call(
        &sessions,
        Some(&store),
        "update_task",
        json!({ "id": 2, "status": "Done" }),
    )
    .await;
    assert_eq!(refused.error.as_deref(), Some("no task 2 in this project"));
    let untouched = crate::task_store::list(
        &*store.lock().await,
        &crate::project_path::canonical_project_path(&other_path),
    )
    .expect("list");
    assert!(untouched
        .iter()
        .all(|task| task.status == TaskStatus::Planning));
}

#[tokio::test]
async fn project_prompts_are_answered_from_the_store() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&project_path, None));
    let store = Some(&store);

    let created = ok(call(
        &sessions,
        store,
        "create_prompt",
        json!({ "title": "Review", "body": "Review the diff", "tags": ["Code"] }),
    )
    .await);
    assert_eq!(created["id"], "project-1");
    assert_eq!(created["tags"], json!(["code"]));
    ok(call(
        &sessions,
        store,
        "create_prompt",
        json!({ "title": "Plan", "body": "Plan it", "collection": "project" }),
    )
    .await);

    // Partial: the body and tags the agent left out are kept.
    let updated = ok(call(
        &sessions,
        store,
        "update_prompt",
        json!({ "id": "project-1", "title": "Review again", "favorite": true }),
    )
    .await);
    assert_eq!(updated["title"], "Review again");
    assert_eq!(updated["body"], "Review the diff");
    assert_eq!(updated["tags"], json!(["code"]));
    assert_eq!(updated["favorite"], true);

    // No window: the project's alone, and a note saying why.
    let listed = ok(call(&sessions, store, "list_prompts", json!({})).await);
    let ids: Vec<&str> = listed["prompts"]
        .as_array()
        .expect("prompts")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert_eq!(ids, ["project-1", "project-2"]);
    assert_eq!(listed["shared_unavailable"], NO_WINDOW);
    let tagged = ok(call(&sessions, store, "list_prompts", json!({ "tag": "code" })).await);
    assert_eq!(tagged["prompts"].as_array().map(Vec::len), Some(1));

    let read = ok(call(&sessions, store, "get_prompt", json!({ "id": "project-2" })).await);
    assert_eq!(read["body"], "Plan it");

    let deleted = ok(call(
        &sessions,
        store,
        "delete_prompt",
        json!({ "id": "project-2" }),
    )
    .await);
    assert_eq!(deleted, json!({ "deleted": "project-2" }));

    let error = |result: HostToolResult| result.error.expect("an error");
    assert_eq!(
        error(
            call(
                &sessions,
                store,
                "delete_prompt",
                json!({ "id": "project-2" })
            )
            .await
        ),
        "no prompt project-2 in this project"
    );
    assert_eq!(
        error(call(&sessions, store, "get_prompt", json!({ "id": 1 })).await),
        "id must be a prompt id from list_prompts, like project-3 or shared-3"
    );
    assert_eq!(
        error(call(&sessions, store, "get_prompt", json!({ "id": "project-9" })).await),
        "no prompt project-9 in this project"
    );
    // A shared call with no window is refused here, not left waiting on nobody.
    assert_eq!(
        error(call(&sessions, store, "get_prompt", json!({ "id": "shared-1" })).await),
        NO_WINDOW
    );

    // Neither half: an empty list and a note for each, not a failure.
    let listed = ok(call(&sessions, None, "list_prompts", json!({})).await);
    assert_eq!(listed["prompts"], json!([]));
    assert_eq!(
        listed["project_unavailable"],
        crate::project_store::UNAVAILABLE
    );
    assert_eq!(listed["shared_unavailable"], NO_WINDOW);
}

/// Every window answers a shared prompt call whether it holds the session or not, so the call
/// must reach one of them only.
#[tokio::test]
async fn a_shared_prompt_call_reaches_one_window() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&project_path, None));
    let sink = crate::client_sink::ClientSink::detached();
    let mut windows = Vec::new();
    for _ in 0..2 {
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        sink.lock().await.attach(Box::new(ours)).await;
        windows.push(theirs);
    }
    let mut pending = PendingHostTools::new();
    let (reply_tx, _reply_rx) = oneshot::channel();
    let call = HostToolCall {
        session_id: "session".to_string(),
        request_id: "request".to_string(),
        name: "get_prompt".to_string(),
        arguments: json!({ "id": "shared-1" }),
    };
    handle_host_tool_call(call, reply_tx, &sessions, None, None, &mut pending, &sink).await;
    assert_eq!(pending.len(), 1);

    let mut received = 0;
    for window in &mut windows {
        let read = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            maestro_protocol::read_message(window),
        )
        .await;
        if let Ok(Ok(ServerResponse::HostToolCall(_))) = read {
            received += 1;
        }
    }
    assert_eq!(received, 1);
}

#[tokio::test]
async fn shared_prompts_go_to_the_host_with_bare_ids() {
    let project = tempfile::tempdir().expect("project dir");
    let project_path = project.path().to_string_lossy().into_owned();
    let store: Store = Arc::new(tokio::sync::Mutex::new(
        crate::project_store::open_in_memory(),
    ));
    let mut sessions = SessionMap::new();
    sessions.insert("session".to_string(), session_in(&project_path, None));
    let sink = crate::client_sink::ClientSink::detached();
    let (ours, mut window) = tokio::io::duplex(1 << 16);
    sink.lock().await.attach(Box::new(ours)).await;
    let mut pending = PendingHostTools::new();

    // Yields the reply's receiver unawaited: the host answers only after every call is parked.
    #[allow(clippy::async_yields_async)]
    let mut send = async |name: &str, arguments: Value| {
        let (reply_tx, reply_rx) = oneshot::channel();
        let call = HostToolCall {
            session_id: "session".to_string(),
            request_id: "request".to_string(),
            name: name.to_string(),
            arguments,
        };
        handle_host_tool_call(
            call,
            reply_tx,
            &sessions,
            Some(&store),
            None,
            &mut pending,
            &sink,
        )
        .await;
        reply_rx
    };
    let next = async |window: &mut tokio::io::DuplexStream| -> ServerResponse {
        maestro_protocol::read_message(window)
            .await
            .expect("a message")
    };

    // A write to the project's collection is pushed to every window.
    let created = send("create_prompt", json!({ "title": "Mine", "body": "Do it" })).await;
    assert!(matches!(
        next(&mut window).await,
        ServerResponse::PromptsChanged(_)
    ));
    assert_eq!(ok(created.await.expect("an answer"))["id"], "project-1");

    let got = send("get_prompt", json!({ "id": "shared-4" })).await;
    let ServerResponse::HostToolCall(forwarded) = next(&mut window).await else {
        panic!("not forwarded");
    };
    assert_eq!(forwarded.name, "get_prompt");
    assert_eq!(forwarded.arguments, json!({ "id": 4 }));

    let created = send(
        "create_prompt",
        json!({ "title": "Ours", "body": "Do it", "collection": "shared" }),
    )
    .await;
    let ServerResponse::HostToolCall(forwarded_create) = next(&mut window).await else {
        panic!("not forwarded");
    };
    assert_eq!(
        forwarded_create.arguments,
        json!({ "title": "Ours", "body": "Do it" })
    );

    let listed = send("list_prompts", json!({})).await;
    let ServerResponse::HostToolCall(forwarded_list) = next(&mut window).await else {
        panic!("not forwarded");
    };

    let mut answer_host = |forwarded: HostToolCall, result: Value| {
        let (_, tx) = pending.remove(&forwarded.request_id).expect("parked");
        tx.send(HostToolResult {
            session_id: forwarded.session_id,
            request_id: forwarded.request_id,
            result,
            error: None,
        })
        .expect("waiting");
    };
    answer_host(forwarded, json!({ "id": 4, "title": "Theirs" }));
    answer_host(forwarded_create, json!({ "id": 5, "title": "Ours" }));
    answer_host(
        forwarded_list,
        json!([{ "id": 4, "title": "Theirs", "tags": [], "favorite": false }]),
    );

    let got = ok(got.await.expect("an answer"));
    assert_eq!(got["id"], "shared-4");
    let created = created.await.expect("an answer");
    assert_eq!(created.request_id, "request");
    assert_eq!(ok(created)["id"], "shared-5");
    let listed = ok(listed.await.expect("an answer"));
    let ids: Vec<&str> = listed["prompts"]
        .as_array()
        .expect("prompts")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert_eq!(ids, ["project-1", "shared-4"]);
    assert!(listed.get("shared_unavailable").is_none());
}

#[tokio::test]
async fn cancel_fails_only_the_closing_session() {
    let (mut pending, mut receivers) =
        pending_with(&[("host-0", "session-1"), ("host-1", "session-2")]);
    cancel_session(&mut pending, "session-1");

    assert_eq!(pending.len(), 1);
    assert!(pending.contains_key("host-1"));
    let failed = receivers.remove(0).await.unwrap();
    assert_eq!(failed.error.as_deref(), Some("session closed"));
    // The surviving call is still waiting, not answered.
    assert!(receivers[0].try_recv().is_err());
}
