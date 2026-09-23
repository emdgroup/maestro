//! The automation and template tools an agent calls on Maestro's MCP server.
//!
//! Automations are scoped to the session's project, as the task tools are: every id an agent names
//! is looked up in that project's own list before anything is done with it. Templates are
//! app-wide, as they are on the Templates page, and the built-ins cannot be changed.
//!
//! Only `run_automation` asks the user first. Everything else is something the user can see and
//! undo on the Automations page; a run is an agent set to work unattended.

use std::sync::Arc;
use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::acp::connection_server::{
    query_automation_runs_via_server, query_delete_automation_via_server,
    query_list_automations_via_server, query_run_automation_via_server,
    query_save_automation_via_server,
};
use crate::acp::transport::HostToolCall;
use crate::acp::ConnectionKey;
use crate::core::AppState;
use crate::project::automations::{
    target, Automation, AutomationRun, AutomationWorkspace, WebhookOverlap,
};
use crate::templates::{self, AutomationTemplate, TemplateBody};

/// How long `run_automation` waits for the user before answering that it is still waiting. Under
/// the 90 seconds the server holds a host call open for.
const CONFIRM_SECONDS: u64 = 60;

/// The option id the confirmation's Run button answers with.
const RUN_OPTION: &str = "run";

/// What an agent may set on an automation. The id, the project path, `next_due_at` and the
/// webhook secret are the server's.
const AUTOMATION_FIELDS: [&str; 12] = [
    "name",
    "prompt",
    "agent_id",
    "model",
    "permission_mode",
    "effort",
    "cron",
    "timezone",
    "enabled",
    "workspace",
    "webhook_enabled",
    "webhook_overlap",
];

/// What an agent may set on a template's body. Name and tag are the template's own.
const TEMPLATE_FIELDS: [&str; 5] = [
    "prompt",
    "cron",
    "timezone",
    "webhook_enabled",
    "webhook_overlap",
];

/// Default number of runs `list_automation_runs` returns, and the most it will.
const DEFAULT_RUNS: u64 = 20;
const MAX_RUNS: u64 = 100;

fn required_str<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

/// `base` with every one of `fields` the agent passed written over it, `null` included, so an
/// agent clears a schedule the same way it sets one. Going through serde means a wrong type is
/// refused with the field's name rather than coerced.
fn overlay<T: Serialize + DeserializeOwned>(
    base: &T,
    arguments: &Value,
    fields: &[&str],
) -> Result<T, String> {
    let mut value = serde_json::to_value(base).map_err(|e| e.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "not an object".to_string())?;
    for field in fields {
        if let Some(given) = arguments.get(*field) {
            object.insert((*field).to_string(), given.clone());
        }
    }
    serde_json::from_value(value).map_err(|e| format!("invalid arguments: {e}"))
}

/// An automation as the agent sees it. Without its webhook secret: a secret an agent can read is
/// one a prompt injection can send somewhere.
fn automation_json(automation: &Automation) -> Value {
    let mut value = serde_json::to_value(automation).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("webhook_secret");
    }
    value
}

fn run_summary(run: &AutomationRun) -> Value {
    json!({
        "id": run.id,
        "automation_id": run.automation_id,
        "automation_name": run.automation_name,
        "number": run.ordinal,
        "status": run.status,
        "trigger": run.trigger,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "error": run.error,
    })
}

struct Project {
    id: i32,
    key: ConnectionKey,
    path: String,
}

async fn project(app_state: &Arc<AppState>, session_id: &str) -> Result<Project, String> {
    let id = super::host_tools::session_project_id(app_state, session_id).await?;
    let (key, path) = target(app_state, id).await?;
    Ok(Project { id, key, path })
}

async fn project_automations(
    app_state: &Arc<AppState>,
    project: &Project,
) -> Result<(Vec<Automation>, String), String> {
    let response =
        query_list_automations_via_server(project.key, project.path.clone(), app_state).await?;
    Ok((
        response.automations.into_iter().map(Into::into).collect(),
        response.server_timezone,
    ))
}

/// The automation `arguments[key]` names, if it is one of this session's project.
async fn find_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
    key: &str,
) -> Result<(Project, Automation), String> {
    let id = required_str(arguments, key)?;
    let project = project(app_state, session_id).await?;
    let (automations, _) = project_automations(app_state, &project).await?;
    let automation = automations
        .into_iter()
        .find(|automation| automation.id == id)
        .ok_or_else(|| format!("no automation {id} in this project"))?;
    Ok((project, automation))
}

async fn save(
    app_state: &Arc<AppState>,
    project: &Project,
    automation: Automation,
) -> Result<Value, String> {
    let saved: Automation = query_save_automation_via_server(
        project.key,
        project.path.clone(),
        automation.into(),
        app_state,
    )
    .await?
    .into();
    app_state.app_handle.emit("automations-changed", ()).ok();
    Ok(automation_json(&saved))
}

pub(super) async fn list_automations(
    app_state: &Arc<AppState>,
    session_id: &str,
) -> Result<Value, String> {
    let project = project(app_state, session_id).await?;
    let (automations, server_timezone) = project_automations(app_state, &project).await?;
    let rows: Vec<Value> = automations
        .iter()
        .map(|automation| {
            json!({
                "id": automation.id,
                "name": automation.name,
                "enabled": automation.enabled,
                "cron": automation.cron,
                "timezone": automation.timezone,
                "webhook_enabled": automation.webhook_enabled,
                "next_due_at": automation.next_due_at,
            })
        })
        .collect();
    Ok(json!({ "automations": rows, "server_timezone": server_timezone }))
}

pub(super) async fn get_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, automation) = find_automation(app_state, session_id, arguments, "id").await?;
    Ok(automation_json(&automation))
}

/// A new automation, filled in the way the editor fills one: the template's fields if one is
/// named, the project's default agent and workspace, and then whatever the agent passed.
pub(super) async fn create_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let project = project(app_state, session_id).await?;
    let (_, server_timezone) = project_automations(app_state, &project).await?;
    let config = crate::project::settings::load_project_config_for(app_state, project.id)
        .await
        .unwrap_or_default();

    let agent_id = match config.default_agent.clone().filter(|id| !id.is_empty()) {
        Some(agent_id) => agent_id,
        // A project with no default agent: the one this session runs is at least installed.
        None => app_state
            .acp
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|session| session.agent_id_meta.clone())
            .unwrap_or_default(),
    };
    let workspace = match config.default_workspace_mode() {
        crate::models::WorkspaceMode::NewWorktree => AutomationWorkspace::NewWorktree {
            base_branch: super::host_tools::default_base_branch(app_state, project.id, &config)
                .await,
        },
        // A pinned workspace needs a path the agent has to name.
        _ => AutomationWorkspace::Repository,
    };

    let mut automation = Automation {
        id: format!("automation-{}", uuid::Uuid::new_v4().simple()),
        project_path: project.path.clone(),
        name: String::new(),
        prompt: String::new(),
        agent_id,
        cron: None,
        timezone: server_timezone,
        enabled: true,
        model: None,
        permission_mode: None,
        effort: None,
        workspace,
        webhook_enabled: false,
        webhook_overlap: WebhookOverlap::Refuse,
        webhook_secret: None,
        next_due_at: None,
    };

    if arguments.get("template_id").is_some_and(|id| !id.is_null()) {
        let template = find_template(app_state, arguments, "template_id")?;
        let TemplateBody::Automation(body) = template.body;
        automation.name = template.name;
        automation.prompt = body.prompt;
        automation.cron = body.cron;
        // A built-in carries no zone: "09:00" means wherever it is being set up.
        if !body.timezone.is_empty() {
            automation.timezone = body.timezone;
        }
        automation.webhook_enabled = body.webhook_enabled;
        automation.webhook_overlap = body.webhook_overlap;
    }

    let automation = overlay(&automation, arguments, &AUTOMATION_FIELDS)?;
    save(app_state, &project, automation).await
}

pub(super) async fn update_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (project, automation) = find_automation(app_state, session_id, arguments, "id").await?;
    if !AUTOMATION_FIELDS
        .iter()
        .any(|field| arguments.get(*field).is_some())
    {
        return Err("nothing to update".to_string());
    }
    let automation = overlay(&automation, arguments, &AUTOMATION_FIELDS)?;
    save(app_state, &project, automation).await
}

pub(super) async fn delete_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (project, automation) = find_automation(app_state, session_id, arguments, "id").await?;
    query_delete_automation_via_server(project.key, automation.id.clone(), app_state).await?;
    app_state.app_handle.emit("automations-changed", ()).ok();
    Ok(json!({ "deleted": automation.id }))
}

/// What the confirmation shows under its heading: enough to know what saying yes starts.
fn run_summary_text(automation: &Automation) -> String {
    let workspace = match &automation.workspace {
        AutomationWorkspace::Repository => "the project directory".to_string(),
        AutomationWorkspace::Path { path } => path.clone(),
        AutomationWorkspace::NewWorktree { base_branch } => {
            format!("a new worktree from {base_branch}")
        }
    };
    let trigger = match &automation.cron {
        Some(cron) => format!("Schedule, {cron} ({})", automation.timezone),
        None if automation.webhook_enabled => "Webhook".to_string(),
        None => "On demand".to_string(),
    };
    let mut prompt: String = automation.prompt.chars().take(400).collect();
    if prompt.len() < automation.prompt.len() {
        prompt.push('…');
    }
    format!(
        "Agent      {}\nWorkspace  {workspace}\nTrigger    {trigger}\n\n{prompt}",
        automation.agent_id
    )
}

/// Start a run, once the user has said yes.
///
/// The question is a permission prompt like any other: the same event, the same sheet, answered
/// through `respond_acp_permission`, which hands the answer back here rather than to the server.
/// The answer is acted on by a task of its own, so a user who replies after this call has given
/// up waiting still gets the run they approved.
pub(super) async fn run_automation(
    app_state: &Arc<AppState>,
    session_id: &str,
    call: &HostToolCall,
) -> Result<Value, String> {
    let (project, automation) =
        find_automation(app_state, session_id, &call.arguments, "id").await?;

    let (answer_tx, answer_rx) = tokio::sync::oneshot::channel::<Value>();
    app_state
        .acp
        .pending_host_tools
        .lock()
        .await
        .insert((session_id.to_string(), call.request_id.clone()), answer_tx);

    let task_id = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(session_id).and_then(|session| session.task_id)
    };
    if let Some(task_id) = task_id {
        crate::acp::reader_task::mark_task_blocked(app_state, task_id);
    }

    let payload = json!({
        "toolCall": {
            "toolCallId": call.request_id,
            "title": format!("Run automation \u{201c}{}\u{201d}?", automation.name),
            "kind": "other",
            "content": [{ "type": "text", "text": run_summary_text(&automation) }],
        },
        "options": [
            { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
            { "optionId": RUN_OPTION, "name": "Run now", "kind": "allow_once" },
        ],
    });
    if let Err(e) = app_state.app_handle.emit(
        &format!("acp://permission-request/{session_id}"),
        &json!({ "session_id": session_id, "request_id": call.request_id, "payload": payload }),
    ) {
        log::warn!("[acp] emit permission-request/{session_id} failed: {e}");
    }

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let state = Arc::clone(app_state);
    let automation_id = automation.id.clone();
    tokio::spawn(async move {
        // A dropped sender is a question nobody answered, which is not a yes.
        let approved = matches!(answer_rx.await, Ok(Value::String(option)) if option == RUN_OPTION);
        let outcome = if approved {
            query_run_automation_via_server(project.key, automation_id, &state)
                .await
                .map(|()| {
                    json!({
                        "started": true,
                        "note": "The run is starting. Follow it with list_automation_runs.",
                    })
                })
        } else {
            Ok(json!({ "denied": true }))
        };
        let _ = done_tx.send(outcome);
    });

    match tokio::time::timeout(Duration::from_secs(CONFIRM_SECONDS), done_rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err("the confirmation was dropped".to_string()),
        Err(_) => Ok(json!({
            "pending": true,
            "note": "The user has not answered yet. The question stays on their screen, and the run starts if they approve it. Do not call run_automation again for this; check list_automation_runs later.",
        })),
    }
}

pub(super) async fn list_automation_runs(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let project = project(app_state, session_id).await?;
    let automation_id = arguments.get("automation_id").and_then(Value::as_str);
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_RUNS)
        .clamp(1, MAX_RUNS) as usize;
    let response =
        query_automation_runs_via_server(project.key, project.path, None, app_state).await?;
    let runs: Vec<Value> = response
        .runs
        .into_iter()
        .map(AutomationRun::from)
        .filter(|run| automation_id.is_none_or(|id| run.automation_id == id))
        .take(limit)
        .map(|run| run_summary(&run))
        .collect();
    Ok(json!({ "runs": runs }))
}

pub(super) async fn get_automation_run(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = required_str(arguments, "id")?;
    let project = project(app_state, session_id).await?;
    let response =
        query_automation_runs_via_server(project.key, project.path, None, app_state).await?;
    let run = response
        .runs
        .into_iter()
        .map(AutomationRun::from)
        .find(|run| run.id == id)
        .ok_or_else(|| format!("no run {id} in this project"))?;
    let mut value = run_summary(&run);
    if let Some(object) = value.as_object_mut() {
        object.insert("result".into(), json!(run.result));
        object.insert("worktree_path".into(), json!(run.worktree_path));
        object.insert("worktree_branch".into(), json!(run.worktree_branch));
        object.insert("worktree_kept".into(), json!(run.worktree_kept));
    }
    Ok(value)
}

// --- Templates ---

/// A template of either origin, as the tools speak of it. Ids are the Templates page's own card
/// keys, `user-<n>` and `builtin-<key>`, so an agent never has to be told which list one is in.
struct FoundTemplate {
    id: String,
    name: String,
    tag: Option<String>,
    description: Option<String>,
    body: TemplateBody,
    /// The row id of one of the user's own. `None` for a built-in, which cannot be changed.
    stored: Option<i32>,
}

impl FoundTemplate {
    fn to_json(&self, with_prompt: bool) -> Value {
        let mut value = serde_json::to_value(&self.body).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            if !with_prompt {
                object.remove("prompt");
            }
            object.insert("id".into(), json!(self.id));
            object.insert("name".into(), json!(self.name));
            object.insert("tag".into(), json!(self.tag));
            object.insert("built_in".into(), json!(self.stored.is_none()));
            if let Some(description) = &self.description {
                object.insert("description".into(), json!(description));
            }
        }
        value
    }
}

fn all_templates(app_state: &Arc<AppState>) -> Result<Vec<FoundTemplate>, String> {
    let stored = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        templates::list(&conn)?
    };
    let own = stored.into_iter().map(|template| FoundTemplate {
        id: format!("user-{}", template.id),
        name: template.name,
        tag: template.tag,
        description: None,
        body: template.body,
        stored: Some(template.id),
    });
    let builtin = templates::builtins().iter().map(|template| FoundTemplate {
        id: format!("builtin-{}", template.key),
        name: template.name.clone(),
        tag: Some(template.tag.clone()),
        description: Some(template.description.clone()),
        body: template.body.clone(),
        stored: None,
    });
    Ok(own.chain(builtin).collect())
}

fn find_template(
    app_state: &Arc<AppState>,
    arguments: &Value,
    key: &str,
) -> Result<FoundTemplate, String> {
    let id = required_str(arguments, key)?;
    all_templates(app_state)?
        .into_iter()
        .find(|template| template.id == id)
        .ok_or_else(|| format!("no template {id}"))
}

/// One of the user's own, or why it cannot be changed.
fn find_own_template(
    app_state: &Arc<AppState>,
    arguments: &Value,
) -> Result<(i32, FoundTemplate), String> {
    let template = find_template(app_state, arguments, "id")?;
    match template.stored {
        Some(id) => Ok((id, template)),
        None => Err(format!(
            "{} is built in and cannot be changed — save an automation made from it as a template instead",
            template.id
        )),
    }
}

fn save_template(
    app_state: &Arc<AppState>,
    id: Option<i32>,
    name: &str,
    tag: Option<&str>,
    body: &TemplateBody,
) -> Result<Value, String> {
    let saved = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        templates::save(&conn, id, name, tag, body)?
    };
    app_state.app_handle.emit("templates-changed", ()).ok();
    Ok(FoundTemplate {
        id: format!("user-{}", saved.id),
        name: saved.name,
        tag: saved.tag,
        description: None,
        body: saved.body,
        stored: Some(saved.id),
    }
    .to_json(true))
}

/// A tag the agent passed: absent keeps the current one, `null` or blank clears it.
fn tag_argument(arguments: &Value, current: Option<String>) -> Result<Option<String>, String> {
    match arguments.get("tag") {
        None => Ok(current),
        Some(Value::Null) => Ok(None),
        Some(Value::String(tag)) => Ok(Some(tag.clone())),
        Some(other) => Err(format!("tag must be a string, got {other}")),
    }
}

pub(super) fn list_templates(app_state: &Arc<AppState>) -> Result<Value, String> {
    let rows: Vec<Value> = all_templates(app_state)?
        .iter()
        .map(|template| template.to_json(false))
        .collect();
    Ok(json!({ "templates": rows }))
}

pub(super) fn get_template(app_state: &Arc<AppState>, arguments: &Value) -> Result<Value, String> {
    Ok(find_template(app_state, arguments, "id")?.to_json(true))
}

pub(super) fn update_template(
    app_state: &Arc<AppState>,
    arguments: &Value,
) -> Result<Value, String> {
    let (id, template) = find_own_template(app_state, arguments)?;
    let TemplateBody::Automation(body) = &template.body;
    let body: AutomationTemplate = overlay(body, arguments, &TEMPLATE_FIELDS)?;
    let name = match arguments.get("name") {
        None | Some(Value::Null) => template.name.clone(),
        Some(_) => required_str(arguments, "name")?.to_string(),
    };
    let tag = tag_argument(arguments, template.tag)?;
    save_template(
        app_state,
        Some(id),
        &name,
        tag.as_deref(),
        &TemplateBody::Automation(body),
    )
}

pub(super) async fn save_as_template(
    app_state: &Arc<AppState>,
    session_id: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, automation) =
        find_automation(app_state, session_id, arguments, "automation_id").await?;
    let name = match arguments.get("name") {
        None | Some(Value::Null) => automation.name.clone(),
        Some(_) => required_str(arguments, "name")?.to_string(),
    };
    let tag = tag_argument(arguments, None)?;
    let body = TemplateBody::Automation(AutomationTemplate {
        prompt: automation.prompt,
        cron: automation.cron,
        timezone: automation.timezone,
        webhook_enabled: automation.webhook_enabled,
        webhook_overlap: automation.webhook_overlap,
    });
    save_template(app_state, None, &name, tag.as_deref(), &body)
}

pub(super) fn delete_template(
    app_state: &Arc<AppState>,
    arguments: &Value,
) -> Result<Value, String> {
    let (id, template) = find_own_template(app_state, arguments)?;
    {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        templates::delete(&conn, id)?;
    }
    app_state.app_handle.emit("templates-changed", ()).ok();
    Ok(json!({ "deleted": template.id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_writes_only_the_named_fields_and_clears_with_null() {
        let base = AutomationTemplate {
            prompt: "old".into(),
            cron: Some("0 9 * * *".into()),
            timezone: "UTC".into(),
            webhook_enabled: false,
            webhook_overlap: WebhookOverlap::Refuse,
        };
        let arguments = json!({ "prompt": "new", "cron": null, "id": "ignored" });
        let merged = overlay(&base, &arguments, &TEMPLATE_FIELDS).unwrap();
        assert_eq!(merged.prompt, "new");
        assert_eq!(merged.cron, None);
        assert_eq!(merged.timezone, "UTC");

        let wrong = json!({ "webhook_enabled": "yes" });
        assert!(overlay(&base, &wrong, &TEMPLATE_FIELDS).is_err());
    }
}
