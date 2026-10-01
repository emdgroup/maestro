//! One stage of a task started in the daemon, so the pipeline runs with no window open.
//!
//! A port of `execute` in `useExecuteTask.ts`, in its order: the planner first where the project
//! has one, capacity, the agent, the claim, the workspace, the spawn, the stage's settings, the
//! prompt, and the session ready. An unattended start behaves as it does in the app: missing
//! attachments are skipped and a start that cannot go ahead leaves a note in the thread.
//!
//! [`begin`] is the part that runs on the main loop: SQLite and two small files. [`launch`] runs
//! off it, since a worktree and an agent are slow, and hands the session back through
//! [`Settle::TaskStarted`](crate::dispatch::Settle) so [`adopt`] puts it in the map, closes the
//! sessions it supersedes and answers.

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    AddTaskCommentRequest, AgentRole, ApplyTaskTransitionRequest, ConcurrencyMode, ErrorResponse,
    MaestroRpcMessage, NewTaskComment, RequestTaskExecutionRequest, ServerRequest, ServerResponse,
    StartTaskRequest, StartTaskResponse, Task, TaskSessionStarted, TaskStatus, TaskTransition,
    TransitionGuard, AUTH_REQUIRED_ERROR,
};
use rusqlite::Connection;

use crate::agent::registry::DiscoveredAgentWithSpawn;
use crate::helpers::{broadcast, send_diag, send_response};
use crate::profiles;
use crate::sessions::{ActiveSession, SessionCommand, SessionMap, SharedAgentConnections};

type SpawnParams = (String, Vec<String>, HashMap<String, String>);

/// What the loop decided: the task waits for a slot, or it is claimed and ready to launch.
pub(crate) enum Begun {
    Deferred,
    Claimed(Box<Claimed>),
}

pub(crate) struct Claimed {
    pub project_path: String,
    /// As the claim left it.
    pub task: Task,
    /// The role that runs, the planner where the request asked for a coder that has to plan first.
    pub role: AgentRole,
    pub agent_id: String,
    pub spawn: SpawnParams,
    pub feedback: Option<String>,
    pub unattended: bool,
}

/// A session up, prompted and its task moved on, on its way into the map.
pub(crate) struct Started {
    pub session_id: String,
    pub session: ActiveSession,
    pub push: TaskSessionStarted,
    /// The requester's sink, for the one reply.
    pub reply: crate::ClientOut,
}

/// What the app's Settings calls each stage.
fn stage(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Refiner => "Refinement",
        AgentRole::Planner => "Planning",
        AgentRole::Coder => "Implementation",
        AgentRole::Reviewer => "Review",
    }
}

/// A store request answered as a window's would be, its pushes collected for the caller to send.
fn store_request(
    conn: &mut Connection,
    request: ServerRequest,
    pushes: &mut Vec<ServerResponse>,
) -> Result<ServerResponse, String> {
    let (reply, more) = crate::task_store::requests::answer(conn, request)?;
    pushes.extend(more);
    Ok(reply)
}

fn note(body: String) -> NewTaskComment {
    NewTaskComment {
        kind: "note".to_string(),
        author: "maestro".to_string(),
        body: Some(body),
        external_ref: None,
        phase: None,
    }
}

fn add_note(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    body: String,
    pushes: &mut Vec<ServerResponse>,
) {
    let request = ServerRequest::AddTaskComment(AddTaskCommentRequest {
        project_path: project_path.to_string(),
        task_id,
        comment: note(body),
    });
    if let Err(e) = store_request(conn, request, pushes) {
        send_diag("warn", format!("[task] could not file a note: {e}"));
    }
}

fn transition(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    comment: Option<NewTaskComment>,
    pushes: &mut Vec<ServerResponse>,
) -> Result<Option<Task>, String> {
    let request = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: project_path.to_string(),
        task_id,
        event,
        guard,
        update: None,
        comment,
    });
    match store_request(conn, request, pushes)? {
        ServerResponse::ApplyTaskTransitionOk(reply) => Ok(reply.task),
        _ => Err("unexpected reply to a transition".to_string()),
    }
}

fn spawn_params(agents: &[DiscoveredAgentWithSpawn], agent_id: &str) -> Option<SpawnParams> {
    agents.iter().find(|a| a.id == agent_id).map(|a| {
        (
            a.spawn_cmd.clone(),
            a.spawn_args.clone(),
            a.spawn_env.clone(),
        )
    })
}

/// Steps one to four: the role, capacity, the agent and the claim. Nothing is claimed unless all
/// of it holds, so a refusal leaves the card where it was. `used_slots` is the session map's count.
pub(crate) fn begin(
    conn: &mut Connection,
    request: &StartTaskRequest,
    used_slots: usize,
    agents: &[DiscoveredAgentWithSpawn],
    pushes: &mut Vec<ServerResponse>,
) -> Result<Begun, String> {
    let project_path = crate::automations::canonical_project_path(&request.project_path);
    let task = crate::task_store::get(conn, &project_path, request.task_id)?
        .ok_or_else(|| format!("No task {} in this project", request.task_id))?;

    // The planner runs first from a standing start when the project has one and the task has not
    // turned it off. Not at the plan gate, where approving calls this with the coder.
    let planner_first = request.role == AgentRole::Coder
        && task.phase.is_none()
        && !profiles::role_is_skipped(task.profile_overrides.as_deref(), AgentRole::Planner)
        && profiles::read_profiles(&project_path)
            .resolve(
                AgentRole::Planner,
                profiles::profile_id_for(&task, AgentRole::Planner).as_deref(),
            )
            .is_some();
    let role = if planner_first {
        AgentRole::Planner
    } else {
        request.role
    };

    // Only a fixed limit defers; Auto at its limit starts anyway, as the app's `Warn` does. A
    // limit that cannot be read starts too: the claim below is what decides.
    if request.respect_capacity {
        if let Ok(status) = crate::pipeline_settings::capacity_status(conn) {
            let full = used_slots >= status.slots.max(0) as usize;
            if full && status.settings.concurrency_mode == ConcurrencyMode::Hard {
                let ask = ServerRequest::RequestTaskExecution(RequestTaskExecutionRequest {
                    project_path: project_path.clone(),
                    task_id: task.id,
                });
                if let ServerResponse::RequestTaskExecutionOk(reply) =
                    store_request(conn, ask, pushes)?
                {
                    if reply.deferred {
                        return Ok(Begun::Deferred);
                    }
                }
            }
        }
    }

    let agent = profiles::agent_for(&project_path, &task, role);
    let spawn = agent.as_deref().and_then(|id| spawn_params(agents, id));
    let (Some(agent_id), Some(spawn)) = (agent.clone(), spawn) else {
        let reason = match agent {
            None => format!(
                "No agent to run the {} stage of \"{}\". Give this role an agent profile, or set a default agent for the project.",
                stage(role),
                task.title
            ),
            Some(id) => format!(
                "The agent '{id}' is unknown on this machine, so the {} stage of \"{}\" cannot start.",
                stage(role),
                task.title
            ),
        };
        if request.unattended {
            add_note(conn, &project_path, task.id, reason.clone(), pushes);
        }
        return Err(reason);
    };

    // InProgress only for the plan gate: the claim refuses any phase but the gate's.
    let claimed = transition(
        conn,
        &project_path,
        task.id,
        TaskTransition::ExecutionStarted,
        TransitionGuard::Claim(vec![
            TaskStatus::Planning,
            TaskStatus::Queue,
            TaskStatus::InProgress,
        ]),
        None,
        pushes,
    )?;
    let Some(task) = claimed else {
        return Err(format!("\"{}\" is no longer waiting to start", task.title));
    };

    Ok(Begun::Claimed(Box::new(Claimed {
        project_path,
        task,
        role,
        agent_id,
        spawn,
        feedback: request.feedback.clone(),
        unattended: request.unattended,
    })))
}

/// Why a claimed start did not finish.
enum Failure {
    Failed(String),
    AuthRequired,
    /// The task stopped being the one claimed: a user moved or stopped it. Their action wins.
    Moved,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Failed(message)
    }
}

pub(crate) struct Launcher {
    pub store: crate::project_store::Store,
    pub agent_connections: SharedAgentConnections,
    pub settle_tx: crate::dispatch::SettleTx,
    /// The requester's sink: one reply goes there.
    pub reply: crate::ClientOut,
}

/// Steps five onwards, off the loop. Hands a started session to the loop, or releases the claim
/// and answers with why.
pub(crate) async fn launch(launcher: Launcher, claimed: Box<Claimed>) {
    let everyone = crate::client_sink::ClientSink::everyone(&launcher.reply).await;
    let (project_path, task_id, role, unattended, title, agent_id) = (
        claimed.project_path.clone(),
        claimed.task.id,
        claimed.role,
        claimed.unattended,
        claimed.task.title.clone(),
        claimed.agent_id.clone(),
    );
    let failure = match run(&launcher, &everyone, *claimed).await {
        Ok(started) => {
            if let Err(e) = launcher
                .settle_tx
                .send(crate::dispatch::Settle::TaskStarted(Box::new(started)))
            {
                // The loop is gone, and the session with it.
                send_diag("warn", format!("[task] the server stopped: {e}"));
            }
            return;
        }
        Err(failure) => failure,
    };

    let (event, comment, message) = match failure {
        Failure::Failed(message) => (
            TaskTransition::PhaseFailed,
            unattended.then(|| {
                note(format!(
                    "The {} stage could not start: {message}",
                    stage(role)
                ))
            }),
            message,
        ),
        Failure::AuthRequired if unattended => (
            TaskTransition::PhaseFailed,
            Some(note(format!(
                "The {} stage could not start: '{agent_id}' needs you to sign in. Sign in from Maestro, then run the task again.",
                stage(role)
            ))),
            AUTH_REQUIRED_ERROR.to_string(),
        ),
        // A sign-in is a prompt the window answers, not a failure to show.
        Failure::AuthRequired => (
            TaskTransition::SpawnAborted,
            None,
            AUTH_REQUIRED_ERROR.to_string(),
        ),
        Failure::Moved => (
            TaskTransition::SpawnAborted,
            None,
            format!("\"{title}\" was moved while starting"),
        ),
    };
    send_diag(
        "warn",
        format!("[task] task {task_id} did not start: {message}"),
    );
    let mut pushes = Vec::new();
    {
        let mut conn = launcher.store.lock().await;
        if let Err(e) = transition(
            &mut conn,
            &project_path,
            task_id,
            event,
            TransitionGuard::Spawning,
            comment,
            &mut pushes,
        ) {
            send_diag(
                "warn",
                format!("[task] could not release task {task_id}: {e}"),
            );
        }
    }
    for push in pushes {
        broadcast(&everyone, push).await;
    }
    reply_error(&launcher.reply, message).await;
}

async fn reply_error(reply: &crate::ClientOut, message: String) {
    let response = MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
        message,
        session_id: None,
    }));
    if let Err(e) = send_response(reply, &response).await {
        send_diag("warn", format!("[task] could not answer a start: {e}"));
    }
}

async fn run(
    launcher: &Launcher,
    everyone: &crate::ClientOut,
    claimed: Claimed,
) -> Result<Started, Failure> {
    let Claimed {
        project_path,
        task,
        role,
        agent_id,
        spawn: (command, args, env),
        feedback,
        unattended,
    } = claimed;

    let workspace = crate::worktree::prepare_task_workspace(&launcher.store, &task, role).await?;

    // The agent process runs in the project, never in the worktree: see `automation_runner`.
    let connection = crate::helpers::ensure_and_get_connection(
        &agent_id,
        &launcher.agent_connections,
        &command,
        &args,
        &env,
        &project_path,
        everyone,
    )
    .await
    .ok_or_else(|| format!("The agent {agent_id} could not be started"))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let requested_at = chrono::Utc::now();
    let mut result = match crate::session::connection::create_session_on_connection(
        &connection,
        session_id.clone(),
        &agent_id,
        &workspace.cwd,
        &[],
        Arc::clone(everyone),
    )
    .await
    {
        Ok(result) => result,
        Err(message) if message == AUTH_REQUIRED_ERROR => return Err(Failure::AuthRequired),
        Err(message) => {
            crate::helpers::evict_if_same_connection(
                &launcher.agent_connections,
                &agent_id,
                &connection.router,
            )
            .await;
            return Err(Failure::Failed(message));
        }
    };

    let capabilities = profiles::AgentCapabilities {
        model_ids: result
            .models
            .as_ref()
            .map(|m| {
                m.available_models
                    .iter()
                    .map(|m| m.model_id.clone())
                    .collect()
            })
            .unwrap_or_default(),
        mode_ids: result
            .modes
            .as_ref()
            .map(|m| {
                m.available_modes
                    .iter()
                    .map(|m| m.mode_id.clone())
                    .collect()
            })
            .unwrap_or_default(),
        supports_effort: crate::automation_runner::effort_option_id(result.config_options.as_ref())
            .is_some(),
    };

    // Before the prompt, which `prepare` sends: the session's row is only written once it is
    // adopted, and the agent may ask a question before then.
    crate::session::task_gate::bind(
        &connection.router,
        &result.acp_session_id,
        &project_path,
        task.id,
    )
    .await;
    let prepared = prepare(
        launcher,
        everyone,
        &project_path,
        &task,
        role,
        &capabilities,
        result.config_options.as_ref(),
        &result.session,
        feedback.as_deref(),
        unattended,
    )
    .await;
    let profile_id = match prepared {
        Ok(profile_id) => profile_id,
        Err(failure) => {
            // Not in the map yet, so closed here rather than through `Cancel`.
            crate::dispatch::close_session(
                &session_id,
                result.session,
                &launcher.agent_connections,
                None,
                everyone,
            )
            .await;
            return Err(failure);
        }
    };

    let role_json = serde_json::json!({ "role": role, "profile_id": profile_id }).to_string();
    result.session.agent_id = agent_id.clone();
    result.session.cwd = workspace.cwd;
    result.session.project = Some(crate::sessions::ProjectBinding {
        project_path: project_path.clone(),
        meta: maestro_protocol::SessionMeta {
            session_name: Some(task.title.clone()),
            task_id: Some(task.id),
            task_name: Some(task.title.clone()),
            branch_name: workspace.branch,
            session_start_sha: workspace.start_sha,
            role: Some(role_json),
        },
        can_reload: result.supports_session_load,
        requested_at,
    });

    Ok(Started {
        push: TaskSessionStarted {
            project_path,
            task_id: task.id,
            session_id: session_id.clone(),
            agent_id,
            acp_session_id: result.acp_session_id,
            role,
        },
        session_id,
        session: result.session,
        reply: Arc::clone(&launcher.reply),
    })
}

/// Steps seven to ten on a session that is up: settings, prompt, review cleared, task moved on.
/// Returns the profile the stage ran on.
#[allow(clippy::too_many_arguments)]
async fn prepare(
    launcher: &Launcher,
    everyone: &crate::ClientOut,
    project_path: &str,
    task: &Task,
    role: AgentRole,
    capabilities: &profiles::AgentCapabilities,
    config_options: Option<&Vec<serde_json::Value>>,
    session: &ActiveSession,
    feedback: Option<&str>,
    unattended: bool,
) -> Result<Option<String>, Failure> {
    // A profile set to fail rather than degrade fails the start.
    let settings = profiles::resolve_stage(project_path, task, role, capabilities)?;
    for warning in &settings.warnings {
        send_diag("warn", format!("[task] task {}: {warning}", task.id));
    }

    let mut pushes = Vec::new();
    let composed = {
        let mut conn = launcher.store.lock().await;
        let composed = crate::task_prompt::compose(
            &conn,
            project_path,
            task,
            role,
            settings.role_prompt.as_deref(),
            feedback,
        )?;
        if unattended && !composed.skipped_attachments.is_empty() {
            let count = composed.skipped_attachments.len();
            add_note(
                &mut conn,
                project_path,
                task.id,
                format!(
                    "Started without {count} attachment{}: {}",
                    if count == 1 { "" } else { "s" },
                    composed.skipped_attachments.join("; ")
                ),
                &mut pushes,
            );
        }
        composed
    };

    // Each is a request the agent answers in order, and the prompt behind them cannot overtake
    // them on one command channel, so none is waited on.
    let effort = settings
        .effort
        .clone()
        .zip(crate::automation_runner::effort_option_id(config_options))
        .map(|(value, config_id)| SessionCommand::SetConfigOption { config_id, value });
    let commands = [
        settings.model.clone().map(SessionCommand::SetModel),
        effort,
        settings
            .permission_mode
            .clone()
            .map(SessionCommand::SetMode),
        Some(SessionCommand::PromptStructured(composed.blocks)),
    ];
    for command in commands.into_iter().flatten() {
        if session.cmd_tx.send(command).await.is_err() {
            return Err(Failure::Failed(
                "The session ended before it was asked anything".to_string(),
            ));
        }
    }

    let ready = {
        let mut conn = launcher.store.lock().await;
        // After the prompt, so a review is only dropped once it reached the coder.
        if role == AgentRole::Coder {
            let clear = ServerRequest::ClearTaskReview(maestro_protocol::TaskRef {
                project_path: project_path.to_string(),
                task_id: task.id,
            });
            if let Err(e) = store_request(&mut conn, clear, &mut pushes) {
                send_diag("warn", format!("[task] could not clear a review: {e}"));
            }
        }
        transition(
            &mut conn,
            project_path,
            task.id,
            TaskTransition::SessionReady(role),
            TransitionGuard::Spawning,
            None,
            &mut pushes,
        )
    };
    for push in pushes {
        broadcast(everyone, push).await;
    }
    match ready? {
        Some(_) => Ok(settings.profile_id),
        None => Err(Failure::Moved),
    }
}

/// On the loop: the started session into the map, the task's older sessions closed, and the
/// start answered and announced. Superseding comes after, so a start that fails leaves the task
/// the session it had.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn adopt(
    started: Started,
    sessions: &mut SessionMap,
    agent_connections: &SharedAgentConnections,
    project_store: Option<&crate::project_store::Store>,
    automation_store: Option<&crate::automation_runner::Store>,
    pending_host_tools: &mut crate::mcp_gateway::PendingHostTools,
) {
    let Started {
        session_id,
        session,
        push,
        reply,
    } = started;
    let everyone = crate::client_sink::ClientSink::everyone(&reply).await;
    let registered = crate::register_started_session(
        session_id.clone(),
        session,
        sessions,
        agent_connections,
        project_store,
        automation_store,
        &everyone,
    )
    .await;
    if !registered {
        reply_error(
            &reply,
            "The session was closed while it started".to_string(),
        )
        .await;
        return;
    }

    let superseded: Vec<String> = sessions
        .iter()
        .filter(|(id, session)| {
            **id != session_id
                && session.project.as_ref().is_some_and(|binding| {
                    binding.meta.task_id == Some(push.task_id)
                        && crate::automations::canonical_project_path(&binding.project_path)
                            == push.project_path
                })
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in superseded {
        crate::dispatch::cancel_session(
            &id,
            sessions,
            pending_host_tools,
            agent_connections,
            project_store,
            automation_store,
            &everyone,
        )
        .await;
    }

    broadcast(&everyone, ServerResponse::TaskSessionStarted(push)).await;
    let ok = MaestroRpcMessage::Response(ServerResponse::StartTaskOk(StartTaskResponse {
        session_id: Some(session_id),
    }));
    if let Err(e) = send_response(&reply, &ok).await {
        send_diag("warn", format!("[task] could not answer a start: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{BranchMode, CapacitySettings, CreateTaskRequest, WorkspaceMode};

    fn agent(id: &str) -> DiscoveredAgentWithSpawn {
        DiscoveredAgentWithSpawn {
            id: id.to_string(),
            name: id.to_string(),
            icon: String::new(),
            spawn_cmd: id.to_string(),
            spawn_args: vec![],
            spawn_env: HashMap::new(),
            spawn_deps: vec![],
            custom: false,
        }
    }

    /// A project folder with `default_agent` set, and one task in it.
    fn setup(default_agent: Option<&str>) -> (tempfile::TempDir, String, Connection, Task) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".maestro")).unwrap();
        if let Some(agent) = default_agent {
            std::fs::write(
                dir.path().join(".maestro/settings.json"),
                format!(r#"{{"default_agent":"{agent}"}}"#),
            )
            .unwrap();
        }
        let project = crate::automations::canonical_project_path(&dir.path().to_string_lossy());
        let mut conn = crate::project_store::open_in_memory();
        let task = crate::task_store::create(
            &mut conn,
            &CreateTaskRequest {
                project_path: project.clone(),
                title: "Fix login".to_string(),
                description: None,
                skills: vec![],
                labels: vec![],
                base_branch: "main".to_string(),
                agent_id: None,
                priority: None,
                auto_approve: false,
                workspace_mode: WorkspaceMode::NewWorktree,
                workspace_worktree_id: None,
                workspace_branch_mode: BranchMode::Create,
                workspace_branch: None,
                model_override: None,
            },
        )
        .unwrap();
        (dir, project, conn, task)
    }

    fn request(project: &str, task: &Task) -> StartTaskRequest {
        StartTaskRequest {
            project_path: project.to_string(),
            task_id: task.id,
            role: AgentRole::Coder,
            feedback: None,
            unattended: true,
            respect_capacity: false,
        }
    }

    fn comments(conn: &Connection, project: &str, task: &Task) -> usize {
        crate::task_store::list_comments(conn, project, task.id)
            .unwrap()
            .len()
    }

    #[test]
    fn no_agent_files_a_note_and_claims_nothing() {
        let (_dir, project, mut conn, task) = setup(None);
        let mut pushes = Vec::new();
        let err = begin(&mut conn, &request(&project, &task), 0, &[], &mut pushes)
            .err()
            .unwrap();
        assert!(err.contains("No agent to run the Implementation stage"));
        assert_eq!(comments(&conn, &project, &task), 1);
        let after = crate::task_store::get(&conn, &project, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(after.phase, None);
    }

    #[test]
    fn an_unknown_agent_is_refused_before_the_claim() {
        let (_dir, project, mut conn, task) = setup(Some("ghost"));
        let mut pushes = Vec::new();
        let err = begin(&mut conn, &request(&project, &task), 0, &[], &mut pushes)
            .err()
            .unwrap();
        assert!(err.contains("'ghost' is unknown"));
        let after = crate::task_store::get(&conn, &project, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(after.phase, None);
    }

    #[test]
    fn claims_once_and_refuses_the_second_start() {
        let (_dir, project, mut conn, task) = setup(Some("fake"));
        let agents = [agent("fake")];
        let mut pushes = Vec::new();
        let Ok(Begun::Claimed(claimed)) = begin(
            &mut conn,
            &request(&project, &task),
            0,
            &agents,
            &mut pushes,
        ) else {
            panic!("expected a claim");
        };
        assert_eq!(claimed.role, AgentRole::Coder);
        assert_eq!(claimed.agent_id, "fake");
        assert!(!pushes.is_empty());

        let second = begin(
            &mut conn,
            &request(&project, &task),
            0,
            &agents,
            &mut pushes,
        );
        assert!(second.err().unwrap().contains("no longer waiting to start"));
    }

    #[test]
    fn a_full_fixed_limit_defers() {
        let (_dir, project, mut conn, task) = setup(Some("fake"));
        crate::pipeline_settings::answer(
            &conn,
            ServerRequest::SetCapacity(CapacitySettings {
                concurrency_mode: ConcurrencyMode::Hard,
                max_concurrent_agents: 1,
            }),
        )
        .unwrap();
        let mut start = request(&project, &task);
        start.respect_capacity = true;
        let mut pushes = Vec::new();
        let begun = begin(&mut conn, &start, 1, &[agent("fake")], &mut pushes).unwrap();
        assert!(matches!(begun, Begun::Deferred));
        let after = crate::task_store::get(&conn, &project, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(after.status, TaskStatus::Queue);
        assert_eq!(after.phase, None);
    }

    #[test]
    fn a_coder_with_a_planner_profile_plans_first() {
        let (dir, project, mut conn, task) = setup(Some("fake"));
        std::fs::write(
            dir.path().join(".maestro/profiles.json"),
            r#"{"profiles":[{"id":"p","name":"Planner","role":"Planner","agent_id":"fake"}]}"#,
        )
        .unwrap();
        let mut pushes = Vec::new();
        let Ok(Begun::Claimed(claimed)) = begin(
            &mut conn,
            &request(&project, &task),
            0,
            &[agent("fake")],
            &mut pushes,
        ) else {
            panic!("expected a claim");
        };
        assert_eq!(claimed.role, AgentRole::Planner);
    }
}
