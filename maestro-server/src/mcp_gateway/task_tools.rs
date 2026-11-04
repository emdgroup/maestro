//! The task tools, answered from the project store and scoped to the calling session's project.

use maestro_protocol::mcp_args::{
    enum_argument, required_text, string_argument, string_list_argument,
};
use maestro_protocol::{
    CreateTaskRequest, LoopCheck, LoopCheckEntry, LoopCheckSpec, LoopConfig, NewTaskComment,
    ProjectRef, RunMode, ServerRequest, ServerResponse, TaskDraft, TaskPriority, TaskRef,
    TaskStatus, TaskUpdate, UpdateTaskRequest, WorkspaceMode,
};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::loop_tools::loop_tool;
use super::SessionTask;
use crate::project_store::Store;
use crate::task_store::requests::answer_into;

pub(super) const TASK_TOOLS: [&str; 8] = [
    "create_task",
    "list_tasks",
    "get_task",
    "update_task",
    "comment_task",
    "loop_status",
    "loop_propose_check",
    "loop_blocked",
];

/// Mirrors the `priority` enum in the `create_task` tool schema and `TaskPriority`.
const PRIORITIES: [&str; 5] = ["Urgent", "High", "Medium", "Low", "None"];

/// The board columns, and the only statuses `update_task` accepts.
///
/// `Cancelled` is deliberately absent: cancelling also archives, which an update does not do, so
/// an agent asking for it would produce a task that is cancelled and still sitting on the board.
const STATUSES: [&str; 5] = ["Planning", "Queue", "InProgress", "Review", "Done"];

/// How much of a task's thread `get_task` carries back. Newest kept: an old note matters less
/// than the verdict that came after it, and a CI-heavy task can run to hundreds of entries.
const MAX_THREAD_ENTRIES: usize = 20;

/// The loop fields of `create_task` and `update_task`, each `None` when the agent left it out.
#[derive(Default)]
struct LoopFields {
    run_mode: Option<RunMode>,
    checks: Option<Vec<LoopCheckSpec>>,
    max_iterations: Option<u32>,
    max_build_minutes: Option<u32>,
    stall_limit: Option<u32>,
    check_timeout_minutes: Option<u32>,
    sealed_paths: Option<Vec<String>>,
}

/// One item of `checks` as an agent writes it, its time limit in minutes.
#[derive(serde::Deserialize)]
struct CheckArgument {
    kind: maestro_protocol::LoopCheckKind,
    label: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    timeout_minutes: Option<u32>,
}

impl LoopFields {
    fn parse(arguments: &Value) -> Result<LoopFields, String> {
        let number = |key: &str| -> Result<Option<u32>, String> {
            match arguments.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_u64()
                    .filter(|n| *n >= 1)
                    .and_then(|n| u32::try_from(n).ok())
                    .map(Some)
                    .ok_or_else(|| format!("{key} must be a whole number of at least 1")),
            }
        };
        let checks = match arguments.get("checks") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let items: Vec<CheckArgument> =
                    serde_json::from_value(value.clone()).map_err(|_| {
                        "checks must be a list of {kind, label, command, timeout_minutes}, kind \
                         one of Setup, Command, Judge or Manual"
                            .to_string()
                    })?;
                Some(
                    items
                        .into_iter()
                        .map(|item| {
                            crate::task_store::loops::spec(&LoopCheckSpec {
                                kind: item.kind,
                                label: item.label,
                                command: item.command,
                                timeout_secs: item.timeout_minutes.map(|m| m.saturating_mul(60)),
                            })
                        })
                        .collect::<Result<_, _>>()?,
                )
            }
        };
        Ok(LoopFields {
            run_mode: enum_argument(arguments, "run_mode", &["Pipeline", "Loop"])?
                .map(|name| serde_json::from_value(Value::String(name)))
                .transpose()
                .map_err(|e| e.to_string())?,
            checks,
            max_iterations: number("max_iterations")?,
            max_build_minutes: number("max_build_minutes")?,
            stall_limit: number("stall_limit")?,
            check_timeout_minutes: number("check_timeout_minutes")?,
            sealed_paths: string_list_argument(arguments, "sealed_paths")?,
        })
    }

    fn budgets(&self) -> bool {
        self.max_iterations.is_some()
            || self.max_build_minutes.is_some()
            || self.stall_limit.is_some()
            || self.check_timeout_minutes.is_some()
    }

    /// What a loop that has started no longer takes from an agent.
    fn shape(&self) -> bool {
        self.run_mode.is_some() || self.checks.is_some() || self.sealed_paths.is_some()
    }

    fn any(&self) -> bool {
        self.budgets() || self.shape()
    }

    /// Fields only a loop has.
    fn loop_only(&self) -> bool {
        self.budgets() || self.checks.is_some() || self.sealed_paths.is_some()
    }

    /// `config` with these fields over it. The sealed paths are the ones `sealable` returned.
    fn over(&self, mut config: LoopConfig, sealed: Option<Vec<String>>) -> LoopConfig {
        if let Some(n) = self.max_iterations {
            config.max_iterations = n;
        }
        if let Some(minutes) = self.max_build_minutes {
            config.max_build_secs = minutes.saturating_mul(60);
        }
        if let Some(n) = self.stall_limit {
            config.stall_limit = n;
        }
        if let Some(minutes) = self.check_timeout_minutes {
            config.check_timeout_secs = minutes.saturating_mul(60);
        }
        if let Some(sealed) = sealed {
            config.sealed_paths = sealed;
        }
        config
    }

    /// The sealed paths named, each checked where the checks will run, as the app's are.
    async fn sealed(
        &self,
        store: &Store,
        project_path: &str,
        task_id: Option<i32>,
        base: &str,
    ) -> Result<Option<Vec<String>>, String> {
        let Some(paths) = &self.sealed_paths else {
            return Ok(None);
        };
        let mut sealed = Vec::new();
        for path in paths {
            let found =
                crate::loop_engine::sealable(store, project_path, task_id, base, path).await?;
            sealed.push(found);
        }
        Ok(Some(sealed))
    }
}

pub(super) const NOT_A_LOOP: &str =
    "checks and budgets are a loop's: pass run_mode \"Loop\" with them";

/// One task tool, answered from the store. Every one is scoped to the session's project: ids are
/// small integers, so without that an agent could read or move another project's board by
/// guessing. Returns the result and the pushes the change owes every window.
pub(super) async fn task_tool(
    store: Option<Store>,
    binding: Option<SessionTask>,
    name: &str,
    arguments: &Value,
    draft: Option<TaskDraft>,
) -> Result<(Value, Vec<ServerResponse>), String> {
    let binding =
        binding.ok_or_else(|| "this session is not attached to a Maestro project".to_string())?;
    let store = store.ok_or_else(|| crate::project_store::UNAVAILABLE.to_string())?;
    let project_path = binding.project_path.clone();
    let mut pushes = Vec::new();

    let result = match name {
        "loop_status" | "loop_propose_check" | "loop_blocked" => {
            loop_tool(&store, &binding, name, arguments, &mut pushes).await?
        }
        "create_task" => {
            let title = required_text(arguments, "title")?;
            let priority = parse_priority(arguments)?;
            let fields = LoopFields::parse(arguments)?;
            let looping = fields.run_mode == Some(RunMode::Loop);
            if fields.loop_only() && !looping {
                return Err(NOT_A_LOOP.to_string());
            }
            let (base_branch, workspace_mode) = task_defaults(&project_path).await;
            let (workspace_mode, loop_config) = if looping {
                let sealed = fields
                    .sealed(&store, &project_path, None, &base_branch)
                    .await?;
                let config = fields.over(LoopConfig::default(), sealed);
                (WorkspaceMode::NewWorktree, Some(config))
            } else {
                (workspace_mode, None)
            };
            let request = ServerRequest::CreateTask(CreateTaskRequest {
                project_path: project_path.clone(),
                title,
                description: string_argument(arguments, "description")?,
                skills: Vec::new(),
                labels: string_list_argument(arguments, "labels")?.unwrap_or_default(),
                base_branch,
                agent_id: None,
                priority,
                auto_approve: false,
                workspace_mode,
                workspace_worktree_id: None,
                workspace_branch_mode: maestro_protocol::BranchMode::Create,
                workspace_branch: None,
                model_override: None,
                run_mode: fields.run_mode.unwrap_or_default(),
                loop_config,
            });
            let mut conn = store.lock().await;
            let ServerResponse::CreateTaskOk(task) = answer_into(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            if let Some(checks) = fields.checks.filter(|_| looping) {
                let request =
                    ServerRequest::SetLoopChecks(maestro_protocol::SetLoopChecksRequest {
                        project_path: project_path.clone(),
                        task_id: task.id,
                        checks: checks
                            .into_iter()
                            .map(|spec| LoopCheckEntry { id: None, spec })
                            .collect(),
                    });
                answer_into(&mut conn, request, &mut pushes)?;
            }
            if let Some(draft) = draft {
                crate::task_store::set_drafted_by(&conn, &task.project_path, task.id, &draft)?;
                let run = draft.run.map(|n| format!(", run #{n}")).unwrap_or_default();
                let body = format!("Drafted by the automation \"{}\"{run}.", draft.automation);
                let request =
                    ServerRequest::AddTaskComment(maestro_protocol::AddTaskCommentRequest {
                        project_path,
                        task_id: task.id,
                        comment: crate::task_store::requests::note(body),
                    });
                answer_into(&mut conn, request, &mut pushes)?;
            }
            json!({
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "runMode": task.run_mode,
            })
        }
        "list_tasks" => {
            let wanted: Option<TaskStatus> = match arguments.get("status") {
                Some(value) if !value.is_null() => Some(
                    serde_json::from_value(value.clone())
                        .map_err(|_| format!("unknown status: {value}"))?,
                ),
                _ => None,
            };
            let request = ServerRequest::ListTasks(ProjectRef { project_path });
            let ServerResponse::ListTasksOk(list) =
                answer_into(&mut *store.lock().await, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            let rows: Vec<Value> = list
                .tasks
                .iter()
                .filter(|task| task.archived_at.is_none())
                .filter(|task| wanted.is_none_or(|status| task.status == status))
                .map(task_summary)
                .collect();
            json!({ "tasks": rows })
        }
        "get_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let mut conn = store.lock().await;
            let task = task_in_project(&mut conn, &project_path, task_id)?;
            let checks = match task.run_mode {
                RunMode::Loop => {
                    crate::task_store::loops::list_checks(&conn, &task.project_path, task_id)?
                }
                RunMode::Pipeline => Vec::new(),
            };
            let request = ServerRequest::ListTaskComments(TaskRef {
                project_path,
                task_id,
            });
            let ServerResponse::ListTaskCommentsOk(thread) =
                answer_into(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            drop(conn);

            let total = thread.comments.len();
            let entries: Vec<Value> = thread
                .comments
                .into_iter()
                .skip(total.saturating_sub(MAX_THREAD_ENTRIES))
                .map(|comment| {
                    json!({
                        "kind": comment.kind,
                        "author": comment.author,
                        "body": comment.body,
                        "createdAt": comment.created_at,
                    })
                })
                .collect();
            let mut value = task_summary(&task);
            let object = value
                .as_object_mut()
                .ok_or_else(|| "task summary is not an object".to_string())?;
            object.insert("description".into(), json!(task.description));
            object.insert("baseBranch".into(), json!(task.base_branch));
            object.insert("createdAt".into(), json!(task.created_at));
            object.insert("runMode".into(), json!(task.run_mode));
            if task.run_mode == RunMode::Loop {
                let own = binding.owns_loop(task_id);
                object.insert("loop".into(), loop_json(&task, &checks, own));
            }
            object.insert("thread".into(), Value::Array(entries));
            if total > MAX_THREAD_ENTRIES {
                object.insert("threadTruncated".into(), json!(total - MAX_THREAD_ENTRIES));
            }
            value
        }
        "update_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let status = enum_argument(arguments, "status", &STATUSES)?
                .map(|name| serde_json::from_value::<TaskStatus>(Value::String(name)))
                .transpose()
                .map_err(|e| e.to_string())?;
            let priority = parse_priority(arguments)?;
            let title = match arguments.get("title") {
                None | Some(Value::Null) => None,
                Some(_) => Some(required_text(arguments, "title")?),
            };
            let description = string_argument(arguments, "description")?;
            let labels = string_list_argument(arguments, "labels")?;
            let fields = LoopFields::parse(arguments)?;
            if status.is_none()
                && priority.is_none()
                && title.is_none()
                && description.is_none()
                && labels.is_none()
                && !fields.any()
            {
                return Err("nothing to update".to_string());
            }
            if binding.owns_loop(task_id) {
                return Err("a loop's own session cannot change its task".to_string());
            }

            let task = task_in_project(&mut *store.lock().await, &project_path, task_id)?;
            let mut update = TaskUpdate {
                status,
                title,
                description: description.map(Some),
                priority,
                labels,
                ..TaskUpdate::default()
            };
            if fields.any() {
                if fields.run_mode.is_some_and(|mode| mode != task.run_mode) {
                    return Err("a task's run mode is fixed when it is created".to_string());
                }
                let looping = task.run_mode == RunMode::Loop;
                if fields.loop_only() && !looping {
                    return Err(NOT_A_LOOP.to_string());
                }
                // Prepare loop runs in `Refining`, before the loop starts, and writes exactly these.
                let started = task
                    .phase
                    .is_some_and(|phase| phase != maestro_protocol::TaskPhase::Refining)
                    || !matches!(task.status, TaskStatus::Planning | TaskStatus::Queue);
                if started && fields.shape() {
                    return Err("once a loop has started only its budgets change here; its \
                                checks, setup command and sealed paths change in the app"
                        .to_string());
                }
                if looping {
                    let sealed = fields
                        .sealed(&store, &project_path, Some(task_id), &task.base_branch)
                        .await?;
                    let config = task.loop_config.clone().unwrap_or_default();
                    update.loop_config = Some(fields.over(config, sealed));
                }
            }

            let mut conn = store.lock().await;
            // A status is a manual move, the same as the user dragging the card.
            let request = ServerRequest::UpdateTask(UpdateTaskRequest {
                project_path: project_path.clone(),
                task_id,
                update,
            });
            let ServerResponse::UpdateTaskOk(task) = answer_into(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            if let Some(checks) = fields.checks {
                let request =
                    ServerRequest::SetLoopChecks(maestro_protocol::SetLoopChecksRequest {
                        project_path,
                        task_id,
                        checks: checks
                            .into_iter()
                            .map(|spec| LoopCheckEntry { id: None, spec })
                            .collect(),
                    });
                answer_into(&mut conn, request, &mut pushes)?;
            }
            task_summary(&task)
        }
        // Always a `note`, and always authored `agent`: the typed kinds are the pipeline's own
        // record of what a phase concluded, and a gate pointing at "the plan that was approved"
        // must not be something a tool call can forge afterwards.
        "comment_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let body = required_text(arguments, "body")?;
            let mut conn = store.lock().await;
            task_in_project(&mut conn, &project_path, task_id)?;
            let request = ServerRequest::AddTaskComment(maestro_protocol::AddTaskCommentRequest {
                project_path,
                task_id,
                comment: NewTaskComment {
                    kind: "note".to_string(),
                    author: "agent".to_string(),
                    body: Some(body),
                    external_ref: None,
                    phase: None,
                },
            });
            let ServerResponse::AddTaskCommentOk(comment) =
                answer_into(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            json!({ "id": comment.id, "taskId": task_id, "createdAt": comment.created_at })
        }
        other => return Err(format!("unknown Maestro tool: {other}")),
    };
    Ok((result, pushes))
}

const UNEXPECTED: &str = "the task store answered with the wrong reply";

/// One request through the same path a window's takes, so canonicalization and pushes match.
pub(super) fn task_in_project(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
) -> Result<maestro_protocol::Task, String> {
    let request = ServerRequest::GetTask(TaskRef {
        project_path: project_path.to_string(),
        task_id,
    });
    match crate::task_store::requests::answer(conn, request)?.0 {
        ServerResponse::GetTaskOk(found) => found
            .task
            .ok_or_else(|| format!("no task {task_id} in this project")),
        _ => Err(UNEXPECTED.to_string()),
    }
}

fn task_summary(task: &maestro_protocol::Task) -> Value {
    json!({
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "labels": task.labels,
    })
}

/// A loop as `get_task` shows it. The loop's own sessions get its checks without their commands,
/// and neither the setup command nor the sealed paths: those would say what to game.
fn loop_json(task: &maestro_protocol::Task, checks: &[LoopCheck], own: bool) -> Value {
    let config = task.loop_config.clone().unwrap_or_default();
    let summary = task.loop_summary.as_deref();
    let checks: Vec<Value> = checks
        .iter()
        .map(|check| {
            let mut value = json!({
                "label": check.label,
                "kind": check.kind,
                "state": check.state,
            });
            if check.proposed && !check.accepted {
                value["proposed"] = json!(true);
            }
            if let Some(command) = check.command.as_ref().filter(|_| !own) {
                value["command"] = json!(command);
            }
            if let Some(secs) = check.timeout_secs {
                value["timeoutMinutes"] = json!(secs.div_ceil(60));
            }
            value
        })
        .collect();
    let mut value = json!({
        "checks": checks,
        "maxIterations": config.max_iterations,
        "maxBuildMinutes": config.max_build_secs / 60,
        "stallLimit": config.stall_limit,
        "checkTimeoutMinutes": config.check_timeout_secs / 60,
        "iteration": summary.map_or(0, |s| s.iteration),
        "halt": summary
            .and_then(|s| s.halt)
            .filter(|_| task.ball == maestro_protocol::TaskBall::User),
    });
    if !own {
        value["sealedPaths"] = json!(config.sealed_paths);
    }
    value
}

/// Which task the agent means. An absent `id` is the task this session was started for, which is
/// what the agent almost always wants and cannot otherwise name: it is told what to do, not which
/// card that came from.
fn parse_task_id(binding: &SessionTask, arguments: &Value) -> Result<i32, String> {
    match arguments.get("id") {
        None | Some(Value::Null) => binding
            .task_id
            .ok_or_else(|| "this session is not attached to a task — pass an id".to_string()),
        Some(value) => value
            .as_i64()
            .map(|id| id as i32)
            .ok_or_else(|| format!("id must be a number, got {value}")),
    }
}

fn parse_priority(arguments: &Value) -> Result<Option<TaskPriority>, String> {
    enum_argument(arguments, "priority", &PRIORITIES)?
        .map(|name| serde_json::from_value(Value::String(name)))
        .transpose()
        .map_err(|e| e.to_string())
}

/// A new task's base branch and workspace mode, as the create dialog resolves them: the project's
/// configured defaults, else whatever the repository is on and a worktree of its own. The daemon
/// is on the project's machine, so both are read here.
async fn task_defaults(project_path: &str) -> (String, WorkspaceMode) {
    let settings = crate::project_settings::read(project_path);
    let workspace_mode =
        settings
            .default_workspace_mode
            .unwrap_or(match settings.default_worktree {
                Some(false) => WorkspaceMode::RepositoryDirectory,
                _ => WorkspaceMode::NewWorktree,
            });
    let base_branch = match settings.base_branch {
        Some(branch) => branch,
        None => crate::worktree::git(project_path, &["symbolic-ref", "--short", "HEAD"])
            .await
            .map(|out| out.trim().to_string())
            .ok()
            .filter(|branch| !branch.is_empty())
            .unwrap_or_else(|| "main".to_string()),
    };
    (base_branch, workspace_mode)
}
