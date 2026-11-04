//! The loop worker's tools, answered only for the iteration that is running.

use maestro_protocol::mcp_args::{required_text, string_argument};
use maestro_protocol::{LoopCheck, LoopCheckKind, LoopCheckState, ProjectRef, ServerResponse};
use serde_json::{json, Value};

use super::task_tools::task_in_project;
use super::SessionTask;
use crate::project_store::Store;

/// The worker's loop tools, answered only for the iteration that is running: a session the loop
/// has moved on from no longer acts for it.
pub(super) async fn loop_tool(
    store: &Store,
    binding: &SessionTask,
    name: &str,
    arguments: &Value,
    pushes: &mut Vec<ServerResponse>,
) -> Result<Value, String> {
    use crate::task_store::loops;
    use maestro_protocol::LoopIterationOutcome;

    let (Some(crate::loop_engine::LoopSession::Iteration(n)), Some(task_id)) =
        (&binding.loop_session, binding.task_id)
    else {
        return Err("this session is not a loop iteration".to_string());
    };
    let n = *n;
    let path = crate::project_path::canonical_project_path(&binding.project_path);
    let mut conn = store.lock().await;
    let task = task_in_project(&mut conn, &path, task_id)?;
    let iterations = loops::list_iterations(&conn, &path, task_id)?;
    let running = task.phase == Some(maestro_protocol::TaskPhase::Iterating)
        && iterations
            .iter()
            .any(|i| i.n == n && i.outcome == LoopIterationOutcome::Running);
    if !running {
        return Err(format!(
            "iteration {n} is over, so this session no longer acts for the loop"
        ));
    }
    match name {
        "loop_status" => {
            let checks = loops::list_checks(&conn, &path, task_id)?;
            Ok(loop_status(&task, n, &checks, &iterations))
        }
        "loop_propose_check" => {
            let label = required_text(arguments, "label")?;
            let why = string_argument(arguments, "why")?.filter(|s| !s.trim().is_empty());
            let command = string_argument(arguments, "command")?.filter(|s| !s.trim().is_empty());
            let id = loops::propose_check(
                &mut conn,
                &path,
                task_id,
                &label,
                why.as_deref().map(str::trim),
                command.as_deref().map(str::trim),
            )?;
            pushes.push(ServerResponse::TasksChanged(ProjectRef {
                project_path: path,
            }));
            Ok(json!({
                "id": id,
                "proposed": label,
                "note": "The user decides whether to add it. Carry on meanwhile.",
            }))
        }
        "loop_blocked" => {
            let reason = required_text(arguments, "reason")?;
            loops::set_blocked(&conn, &path, task_id, n, &reason)?;
            Ok(json!({
                "blocked": true,
                "next": "End your turn now. Your work is committed, the checks do not run, and \
                         the loop waits for the user's answer.",
            }))
        }
        other => Err(format!("unknown Maestro tool: {other}")),
    }
}

/// Where the loop stands, for its worker: never a check's command, and the output it is shown is
/// the output its prompt carried.
fn loop_status(
    task: &maestro_protocol::Task,
    n: i32,
    checks: &[LoopCheck],
    iterations: &[maestro_protocol::LoopIteration],
) -> Value {
    use maestro_protocol::LoopIterationOutcome;

    let config = task.loop_config.clone().unwrap_or_default();
    let summary = task.loop_summary.as_deref();
    let counted = summary.map_or(0, |s| s.counted).max(0) as u32;
    // This Build's own time, the limit it is closed at.
    let build_secs = iterations
        .iter()
        .rev()
        .find(|i| i.outcome == LoopIterationOutcome::Running)
        .and_then(|i| chrono::DateTime::parse_from_rfc3339(&i.started_at).ok())
        .map_or(0, |started| {
            (chrono::Utc::now() - started.to_utc()).num_seconds()
        });
    let rows: Vec<Value> = checks
        .iter()
        .filter(|c| !c.proposed || c.accepted)
        .map(|c| {
            let mut value = json!({ "label": c.label, "kind": c.kind, "state": c.state });
            match (c.kind, c.state, c.detail.as_deref()) {
                (
                    LoopCheckKind::Command | LoopCheckKind::Setup,
                    LoopCheckState::Fail | LoopCheckState::Flaky,
                    Some(d),
                ) => value["output"] = json!(d),
                (LoopCheckKind::Judge, _, Some(d)) => value["reason"] = json!(d),
                _ => {}
            }
            value
        })
        .collect();
    let proposals: Vec<&str> = checks
        .iter()
        .filter(|c| c.proposed && !c.accepted)
        .map(|c| c.label.as_str())
        .collect();
    let mut value = json!({
        "goal": task.description,
        "iteration": n,
        "maxIterations": config.max_iterations,
        "budget": {
            "iterationsAfterThis": config.max_iterations.saturating_sub(counted + 1),
            "buildMinutesLeft": (i64::from(config.max_build_secs) - build_secs).max(0) / 60,
        },
        "checks": rows,
        "proposals": proposals,
    });
    let last = iterations
        .iter()
        .rev()
        .find(|i| i.outcome != LoopIterationOutcome::Running);
    if let Some(error) = last
        .filter(|i| i.outcome == LoopIterationOutcome::Failed)
        .and_then(|i| i.check_output.as_deref())
    {
        value["lastError"] = json!(error);
    }
    value
}
