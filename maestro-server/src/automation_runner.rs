//! The clock, and what it does when an automation comes round.
//!
//! This is the half of automations that needs no window. The store next door says what should run
//! and when; this decides that the time has come, spawns the agent, and records what happened.
//!
//! A run is an ordinary session. It appears in `ListLiveSessions` like any other, its permission
//! prompts reach whoever is attached, and phase 2's sweep closes it once the agent is done and
//! nobody is watching. What makes it an automation is the `runs` row pointing at it, which is also
//! how a client that attaches later finds a session nothing of its own started.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use maestro_protocol::{
    AutomationRun, AutomationRunStatus, AutomationWorkspace, MaestroRpcMessage, ServerResponse,
};
use rusqlite::Connection;

use crate::automations;
use crate::helpers::{ensure_and_get_connection, resolve_agent_spawn_params, send_response};
use crate::send_diag;
use crate::session::create_session_on_connection;
use crate::sessions::{ActiveSession, SessionCommand};

/// Shared because the clock writes runs from a spawned task while requests read them on the main
/// loop. A tokio mutex rather than a std one: the writes sit inside async paths either side.
pub type Store = Arc<tokio::sync::Mutex<Connection>>;

/// The ACP config-option categories that mean "how hard should the model think about this".
///
/// Mirrors `findEffortOption` in the frontend, and for the same reason: effort is addressed by the
/// agent's own option id, which is only known once a session has been opened.
const EFFORT_CATEGORIES: [&str; 2] = ["effort", "thought_level"];

/// Everything the runner needs to put an agent on a prompt. The same pieces the `Spawn` arm holds,
/// passed as one so the clock's tick does not grow a five-argument tail.
pub struct Spawner<'a> {
    pub agents_with_spawn: &'a mut Vec<crate::agent::registry::DiscoveredAgentWithSpawn>,
    pub agent_connections: &'a crate::sessions::SharedAgentConnections,
    pub stdout: &'a crate::ClientOut,
    pub spawn_result_tx: &'a tokio::sync::mpsc::Sender<(String, ActiveSession)>,
}

/// Where this automation's agent runs, provisioning a worktree when that is what it asked for.
///
/// A missing directory stops the run rather than moving it to the project: an automation that asked
/// for an isolated workspace must never end up editing the user's checkout unattended.
async fn resolve_cwd(
    store: &Store,
    automation: &maestro_protocol::Automation,
    run_id: &str,
) -> Result<String, String> {
    match &automation.workspace {
        AutomationWorkspace::Repository => Ok(automation.project_path.clone()),
        AutomationWorkspace::Path { path } => {
            if std::path::Path::new(path).is_dir() {
                Ok(path.clone())
            } else {
                Err(format!("The workspace {path} is not there any more"))
            }
        }
        AutomationWorkspace::NewWorktree { base_branch } => {
            let (slug, ordinal) = {
                let conn = store.lock().await;
                automations::worktree_name(&conn, automation)?
            };
            let provisioned =
                crate::worktree::create(&automation.project_path, base_branch, &slug, ordinal)
                    .await?;
            {
                let conn = store.lock().await;
                automations::attach_worktree(
                    &conn,
                    run_id,
                    &provisioned.path,
                    &provisioned.branch,
                    &provisioned.base,
                )?;
            }
            Ok(provisioned.path)
        }
    }
}

/// Deal with the worktree a run left behind, once its session is closed.
///
/// Waiting for the close is not politeness: the agent holds files open under that directory for as
/// long as the session lives, and on Windows a removal while it does simply fails. Nothing here
/// runs for a session that was not an automation's, which is all but a few of them.
pub async fn settle_worktree_for_session(
    store: &Store,
    stdout: &crate::ClientOut,
    session_id: &str,
) {
    let run = {
        let conn = store.lock().await;
        automations::any_run_for_session(&conn, session_id)
    };
    let Some(run) = run else { return };
    settle(store, stdout, &run).await;
}

/// Remove one run's worktree, or record why it was kept.
async fn settle(store: &Store, stdout: &crate::ClientOut, run: &AutomationRun) {
    let (Some(path), Some(branch)) = (run.worktree_path.as_deref(), run.worktree_branch.as_deref())
    else {
        return;
    };
    if run.worktree_kept.is_some() {
        return;
    }

    // A git failure says nothing about whether the tree is clean, so it falls on the keep side —
    // the same rule the app's own sweep follows.
    let kept = match crate::worktree::reason_to_keep(path, branch).await {
        Ok(reason) => reason,
        Err(e) => Some(format!("Maestro could not check it: {e}")),
    };
    let kept = match kept {
        Some(reason) => Some(reason),
        None => match crate::worktree::remove(&run.project_path, path, branch).await {
            Ok(()) => None,
            Err(e) => Some(format!("Maestro could not remove it: {e}")),
        },
    };

    if let Some(reason) = &kept {
        send_diag("info", format!("[automation] keeping {path}: {reason}"));
    }
    let settled = {
        let conn = store.lock().await;
        automations::settle_worktree(&conn, &run.id, kept.as_deref())
    };
    match settled {
        Ok(Some(run)) => announce(stdout, &run).await,
        Ok(None) => {}
        Err(e) => send_diag(
            "warn",
            format!("[automation] could not settle a worktree: {e}"),
        ),
    }
}

/// Deal with worktrees whose runs ended when the server did.
///
/// Called once at startup, after `fail_interrupted_runs` has closed those runs out. Without it a
/// crash mid-run would leave a workspace nothing ever looks at again.
pub async fn sweep_worktrees(store: &Store, stdout: &crate::ClientOut) {
    let unsettled = {
        let conn = store.lock().await;
        automations::runs_with_unsettled_worktrees(&conn)
    };
    match unsettled {
        Ok(runs) => {
            for run in runs {
                settle(store, stdout, &run).await;
            }
        }
        Err(e) => send_diag(
            "warn",
            format!("[automation] cannot look for leftover worktrees: {e}"),
        ),
    }
}

fn effort_option_id(config_options: Option<&Vec<serde_json::Value>>) -> Option<String> {
    config_options?
        .iter()
        .find(|option| {
            option
                .get("category")
                .and_then(|category| category.as_str())
                .is_some_and(|category| EFFORT_CATEGORIES.contains(&category))
        })
        .and_then(|option| option.get("id"))
        .and_then(|id| id.as_str())
        .map(str::to_string)
}

async fn announce(stdout: &crate::ClientOut, run: &AutomationRun) {
    if let Err(e) = send_response(
        stdout,
        &MaestroRpcMessage::Response(ServerResponse::AutomationRunChanged(run.clone())),
    )
    .await
    {
        send_diag(
            "warn",
            format!("[automation] could not announce a run: {e}"),
        );
    }
}

async fn fail(store: &Store, stdout: &crate::ClientOut, run_id: &str, error: String) {
    send_diag("warn", format!("[automation] {error}"));
    let finished = {
        let conn = store.lock().await;
        automations::finish_run(&conn, run_id, AutomationRunStatus::Failed, Some(error))
    };
    match finished {
        Ok(Some(run)) => announce(stdout, &run).await,
        Ok(None) => {}
        Err(e) => send_diag("warn", format!("[automation] could not close a run: {e}")),
    }
}

/// Start one automation, whatever its schedule says.
///
/// Returns the run it opened, which is already recorded by the time this returns: the spawn itself
/// happens in the background, so a slow agent does not hold up the loop that asked.
pub async fn start(
    store: &Store,
    automation_id: &str,
    scheduled: bool,
    spawner: Spawner<'_>,
) -> Result<AutomationRun, String> {
    let automation = {
        let conn = store.lock().await;
        automations::get(&conn, automation_id)?
            .ok_or_else(|| format!("no automation with id {automation_id}"))?
    };

    let run = {
        let conn = store.lock().await;
        automations::start_run(&conn, &automation, scheduled)?
    };
    announce(spawner.stdout, &run).await;

    let cwd = match resolve_cwd(store, &automation, &run.id).await {
        Ok(cwd) => cwd,
        Err(e) => {
            fail(store, spawner.stdout, &run.id, e.clone()).await;
            return Err(e);
        }
    };

    let Some((command, args, env)) = resolve_agent_spawn_params(
        &automation.agent_id,
        spawner.agents_with_spawn,
        spawner.stdout,
    )
    .await
    else {
        let error = format!("The agent {} is not installed here", automation.agent_id);
        fail(store, spawner.stdout, &run.id, error.clone()).await;
        return Err(error);
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    // The agent process runs in the project, never in the worktree: the pooled connection outlives
    // the run, and a process whose working directory is the worktree makes that directory
    // undeletable on Windows. `session/new` below carries the real cwd, which is what the agent
    // works in.
    let agent_cwd = automation.project_path.clone();
    let store = Arc::clone(store);
    let stdout = Arc::clone(spawner.stdout);
    let agent_connections = Arc::clone(spawner.agent_connections);
    let spawn_result_tx = spawner.spawn_result_tx.clone();
    let opened = run.clone();

    tokio::spawn(async move {
        let Some(connection) = ensure_and_get_connection(
            &opened.automation_id,
            &agent_connections,
            &command,
            &args,
            &env,
            &agent_cwd,
            &stdout,
        )
        .await
        else {
            fail(
                &store,
                &stdout,
                &opened.id,
                "The agent could not be started".to_string(),
            )
            .await;
            return;
        };

        let result = create_session_on_connection(
            &connection,
            session_id.clone(),
            &cwd,
            &[],
            Arc::clone(&stdout),
        )
        .await;
        let mut result = match result {
            Ok(result) => result,
            Err(e) => {
                fail(&store, &stdout, &opened.id, e.to_string()).await;
                return;
            }
        };

        {
            let conn = store.lock().await;
            if let Err(e) = automations::attach_session(
                &conn,
                &opened.id,
                &session_id,
                &result.acp_session_id,
                &automation.agent_id,
                &cwd,
                result.supports_session_load,
            ) {
                send_diag("warn", format!("[automation] {e}"));
            }
        }

        // Applied before the prompt and not waited on: each is a request the agent answers in
        // order, and the prompt queued behind them cannot overtake them on one command channel.
        let automation_settings = [
            automation.model.clone().map(SessionCommand::SetModel),
            automation
                .permission_mode
                .clone()
                .map(SessionCommand::SetMode),
            automation
                .effort
                .clone()
                .zip(effort_option_id(result.config_options.as_ref()))
                .map(|(value, config_id)| SessionCommand::SetConfigOption { config_id, value }),
        ];
        for command in automation_settings.into_iter().flatten() {
            if result.session.cmd_tx.send(command).await.is_err() {
                fail(
                    &store,
                    &stdout,
                    &opened.id,
                    "The session ended before it could be set up".to_string(),
                )
                .await;
                return;
            }
        }

        if result
            .session
            .cmd_tx
            .send(SessionCommand::Prompt(automation.prompt.clone()))
            .await
            .is_err()
        {
            fail(
                &store,
                &stdout,
                &opened.id,
                "The session ended before it was asked anything".to_string(),
            )
            .await;
            return;
        }

        result.session.agent_id = automation.agent_id.clone();
        result.session.cwd = cwd;
        // No `host_meta`: the host did not start this and has nothing to attach. The `runs` row is
        // what a client uses to find the session, which is why it is written above.
        if spawn_result_tx
            .send((session_id, result.session))
            .await
            .is_err()
        {
            fail(
                &store,
                &stdout,
                &opened.id,
                "The server stopped before the run could start".to_string(),
            )
            .await;
        }
    });

    Ok(run)
}

/// Close out the run a finished turn belongs to, if it belongs to one.
///
/// Every turn on the server passes through here, and all but an automation's own find nothing.
pub async fn finish_for_session(
    store: &Store,
    stdout: &crate::ClientOut,
    session_id: &str,
    stop_reason: &str,
) {
    let run = {
        let conn = store.lock().await;
        automations::run_for_session(&conn, session_id)
    };
    let Some(run) = run else { return };

    // Anything other than the agent deciding it was done leaves the work unfinished, whether it
    // ran out of budget, refused, or was stopped by hand.
    let (status, error) = match stop_reason {
        "end_turn" => (AutomationRunStatus::Succeeded, None),
        other => (
            AutomationRunStatus::Failed,
            Some(format!("The agent stopped: {other}")),
        ),
    };
    let finished = {
        let conn = store.lock().await;
        automations::finish_run(&conn, &run.id, status, error)
    };
    match finished {
        Ok(Some(run)) => announce(stdout, &run).await,
        Ok(None) => {}
        Err(e) => send_diag("warn", format!("[automation] could not close a run: {e}")),
    }
}

/// Which automations are due, and claiming them so one tick cannot fire the same occurrence twice.
///
/// `floor` is when this server started. An occurrence that passed while it was down is dropped
/// rather than run late: a machine asleep for a day should not wake up and work through
/// twenty-four hourly runs.
fn due_now(conn: &Connection, floor: DateTime<Utc>, now: DateTime<Utc>) -> Vec<String> {
    let scheduled = match automations::list_scheduled(conn) {
        Ok(scheduled) => scheduled,
        Err(e) => {
            send_diag(
                "warn",
                format!("[automation] cannot read the schedule: {e}"),
            );
            return Vec::new();
        }
    };

    scheduled
        .into_iter()
        .filter(|automation| {
            let Some(expression) = automation.cron.as_deref() else {
                return false;
            };
            // Still going from last time. Skipping is what keeps a slow daily run from stacking up
            // agents in the same workspace.
            if automations::is_running(conn, &automation.id) {
                return false;
            }
            let since = automations::last_fired_at(conn, &automation.id)
                .unwrap_or(floor)
                .max(floor);
            automations::next_due(expression, &automation.timezone, since)
                .is_some_and(|next| next <= now)
        })
        .map(|automation| automation.id)
        .collect()
}

/// One turn of the clock.
pub async fn tick(store: &Store, floor: DateTime<Utc>, spawner: Spawner<'_>) {
    let now = Utc::now();
    let due = {
        let conn = store.lock().await;
        let due = due_now(&conn, floor, now);
        for automation_id in &due {
            if let Err(e) = automations::mark_fired(&conn, automation_id, now) {
                send_diag("warn", format!("[automation] {e}"));
            }
        }
        due
    };

    let Spawner {
        agents_with_spawn,
        agent_connections,
        stdout,
        spawn_result_tx,
    } = spawner;
    for automation_id in due {
        send_diag(
            "info",
            format!("[automation] {automation_id} is due, starting it"),
        );
        if let Err(e) = start(
            store,
            &automation_id,
            true,
            Spawner {
                agents_with_spawn,
                agent_connections,
                stdout,
                spawn_result_tx,
            },
        )
        .await
        {
            send_diag("warn", format!("[automation] {automation_id}: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn automation(workspace: AutomationWorkspace) -> maestro_protocol::Automation {
        maestro_protocol::Automation {
            id: "a".to_string(),
            project_path: "/project".to_string(),
            name: "Audit".to_string(),
            prompt: "look".to_string(),
            agent_id: "claude".to_string(),
            cron: None,
            timezone: "UTC".to_string(),
            enabled: true,
            model: None,
            permission_mode: None,
            effort: None,
            workspace,
            next_due_at: None,
        }
    }

    fn empty_store() -> Store {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory database");
        Arc::new(tokio::sync::Mutex::new(conn))
    }

    #[tokio::test]
    async fn a_missing_workspace_stops_the_run_rather_than_moving_it() {
        let store = empty_store();
        let error = resolve_cwd(
            &store,
            &automation(AutomationWorkspace::Path {
                path: "/nowhere/at/all".to_string(),
            }),
            "run-1",
        )
        .await
        .expect_err("a workspace that is gone");
        assert!(error.contains("not there"));

        assert_eq!(
            resolve_cwd(
                &store,
                &automation(AutomationWorkspace::Repository),
                "run-1"
            )
            .await
            .expect("the project itself"),
            "/project"
        );
    }

    #[test]
    fn effort_is_addressed_by_the_agent_s_own_option_id() {
        let options = vec![
            serde_json::json!({"id": "verbosity", "category": "output"}),
            serde_json::json!({"id": "reasoningEffort", "category": "thought_level"}),
        ];
        assert_eq!(
            effort_option_id(Some(&options)).as_deref(),
            Some("reasoningEffort")
        );
        assert_eq!(effort_option_id(None), None);
        assert_eq!(effort_option_id(Some(&vec![])), None);
    }
}
