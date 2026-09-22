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

/// Where this automation's agent runs.
///
/// `NewWorktree` is refused rather than quietly downgraded: falling back to the project directory
/// would turn an automation that asked for an isolated branch into one editing the user's checkout
/// unattended. See phase 4 of `docs/automations-plan.md`.
fn resolve_cwd(workspace: &AutomationWorkspace, project_path: &str) -> Result<String, String> {
    match workspace {
        AutomationWorkspace::Repository => Ok(project_path.to_string()),
        AutomationWorkspace::Path { path } => {
            if std::path::Path::new(path).is_dir() {
                Ok(path.clone())
            } else {
                Err(format!("The workspace {path} is not there any more"))
            }
        }
        AutomationWorkspace::NewWorktree { .. } => Err(
            "Running in a fresh worktree is not available yet, so this automation cannot start"
                .to_string(),
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

    let cwd = match resolve_cwd(&automation.workspace, &automation.project_path) {
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
            &cwd,
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
            if let Err(e) = automations::attach_session(&conn, &opened.id, &session_id) {
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

    #[test]
    fn a_missing_workspace_stops_the_run_rather_than_moving_it() {
        let error = resolve_cwd(
            &AutomationWorkspace::Path {
                path: "/nowhere/at/all".to_string(),
            },
            "/project",
        )
        .expect_err("a workspace that is gone");
        assert!(error.contains("not there"));

        let refused = resolve_cwd(
            &AutomationWorkspace::NewWorktree {
                base_branch: "main".to_string(),
            },
            "/project",
        )
        .expect_err("worktrees are not available yet");
        assert!(refused.contains("not available"));

        assert_eq!(
            resolve_cwd(&AutomationWorkspace::Repository, "/project").expect("the project itself"),
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
