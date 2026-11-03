//! The prompt tools, split between the project's collection, answered here, and the shared one,
//! forwarded to a window.

use std::sync::Arc;

use maestro_protocol::mcp_args::{bool_argument, string_argument, string_list_argument};
use maestro_protocol::{HostToolCall, HostToolResult, ProjectRef, ServerResponse};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{fail, forward_to_one, PendingHostTools, HOST_TIMEOUT};
use crate::project_store::Store;

pub(super) const PROMPT_TOOLS: [&str; 5] = [
    "list_prompts",
    "get_prompt",
    "create_prompt",
    "update_prompt",
    "delete_prompt",
];

/// What an agent sees when it reaches for the shared collection with no window to hold it.
pub(super) const NO_WINDOW: &str =
    "the shared prompts are kept by the Maestro app, and no Maestro window is \
                         open; only this project's prompts are available";

/// How long `list_prompts` waits for the shared half before answering with the project's alone.
const SHARED_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// One prompt tool, split between the two collections.
///
/// The contract with the host, which `src-tauri` implements to match:
///
/// - The agent names a prompt `project-<n>` or `shared-<n>`, because the daemon and the app mint
///   ids independently. The project collection is answered here, from `prompt_store`, scoped to
///   the calling session's project.
/// - A call on the shared collection is forwarded as a `HostToolCall` with the **same tool name**,
///   to exactly one window (`ClientSink::write_to_one`: the session's owner, else the window
///   attached longest), which answers it whether or not it holds the session, and its arguments
///   rewritten: `id`, where there is one, is the bare integer `<n>`, and
///   `create_prompt` loses `collection`. Every other argument (`title`, `body`, `tags`,
///   `favorite`, `list_prompts`' `tag`) passes through as the agent sent it. The host only ever
///   deals with the shared collection and bare integer ids, and answers with bare integer ids.
/// - The gateway prefixes `shared-` on every id in the host's result: `id` on an object or on each
///   element of an array, and `deleted` on `delete_prompt`'s `{deleted}`.
/// - `list_prompts` is the one call that goes both ways. The host answers with an array of
///   `{id, title, tags, favorite}`; the agent gets `{prompts}`, the project's first, then the
///   shared ones. With no window attached, or a host that fails or takes longer than
///   `SHARED_LIST_TIMEOUT`, it gets the project's alone and a `shared_unavailable` note saying
///   why; with no project store or no project bound, the shared ones and `project_unavailable`.
///   Any other shared call with no window attached is refused with `NO_WINDOW`.
/// - Both collections answer a prompt with the same keys: `id`, `title`, `body`, `tags`,
///   `favorite`, `created_at`, `updated_at`.
/// - `update_prompt` has no `shared` argument any more: moving a prompt is a create in the other
///   collection. Its `favorite` stars the prompt in its own collection.
pub(super) async fn prompt_call(
    call: HostToolCall,
    reply_tx: oneshot::Sender<HostToolResult>,
    project_path: Option<String>,
    store: Option<Store>,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    if call.name == "list_prompts" {
        let arguments = call.arguments.clone();
        let shared = forward_to_one(&call, arguments, pending_host_tools, stdout).await;
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            let project = project_prompt_tool(store, project_path, &call, &stdout).await;
            let _ = reply_tx.send(answer(&call, Ok(merge_lists(project, shared).await)));
        });
        return;
    }

    let shared_arguments = match shared_arguments(&call) {
        Ok(arguments) => arguments,
        Err(message) => {
            let _ = reply_tx.send(fail(&call, &message));
            return;
        }
    };
    let Some(arguments) = shared_arguments else {
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            let result = project_prompt_tool(store, project_path, &call, &stdout).await;
            let _ = reply_tx.send(answer(&call, result));
        });
        return;
    };

    let Some(rx) = forward_to_one(&call, arguments, pending_host_tools, stdout).await else {
        let _ = reply_tx.send(fail(&call, NO_WINDOW));
        return;
    };
    tokio::spawn(async move {
        let result = match tokio::time::timeout(HOST_TIMEOUT, rx).await {
            Ok(Ok(HostToolResult {
                error: None,
                mut result,
                ..
            })) => {
                prefix_shared_ids(&mut result);
                Ok(result)
            }
            Ok(Ok(HostToolResult {
                error: Some(message),
                ..
            })) => Err(message),
            Ok(Err(_)) => Err("Maestro dropped the call".to_string()),
            Err(_) => Err("host did not answer".to_string()),
        };
        let _ = reply_tx.send(answer(&call, result));
    });
}

fn answer(call: &HostToolCall, result: Result<Value, String>) -> HostToolResult {
    match result {
        Ok(result) => HostToolResult {
            session_id: call.session_id.clone(),
            request_id: call.request_id.clone(),
            result,
            error: None,
        },
        Err(message) => fail(call, &message),
    }
}

/// The arguments to forward if `call` is on the shared collection, `None` if it is on the
/// project's. `list_prompts` is neither and never comes here.
fn shared_arguments(call: &HostToolCall) -> Result<Option<Value>, String> {
    let mut arguments = call.arguments.clone();
    if call.name == "create_prompt" {
        let collection = arguments
            .as_object_mut()
            .and_then(|object| object.remove("collection"));
        return match collection {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(name)) if name == "project" => Ok(None),
            Some(Value::String(name)) if name == "shared" => Ok(Some(arguments)),
            Some(other) => Err(format!(
                "collection must be \"project\" or \"shared\", got {other}"
            )),
        };
    }
    match parse_prompt_id(&call.arguments)? {
        PromptId::Project(_) => Ok(None),
        PromptId::Shared(id) => {
            if let Some(object) = arguments.as_object_mut() {
                object.insert("id".into(), json!(id));
            }
            Ok(Some(arguments))
        }
    }
}

enum PromptId {
    Project(i32),
    Shared(i32),
}

fn parse_prompt_id(arguments: &Value) -> Result<PromptId, String> {
    let invalid =
        || "id must be a prompt id from list_prompts, like project-3 or shared-3".to_string();
    let raw = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let number = |digits: &str| digits.parse::<i32>().map_err(|_| invalid());
    if let Some(digits) = raw.strip_prefix("project-") {
        Ok(PromptId::Project(number(digits)?))
    } else if let Some(digits) = raw.strip_prefix("shared-") {
        Ok(PromptId::Shared(number(digits)?))
    } else {
        Err(invalid())
    }
}

fn prefix_shared_ids(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(prefix_shared_ids),
        Value::Object(object) => {
            for key in ["id", "deleted"] {
                if let Some(id) = object.get(key).and_then(Value::as_i64) {
                    object.insert(key.into(), json!(format!("shared-{id}")));
                }
            }
        }
        _ => {}
    }
}

/// The project's list followed by the host's. A half that cannot be read is left out, with a note
/// saying why in its place, so one collection failing never hides the other.
async fn merge_lists(
    project: Result<Value, String>,
    shared: Option<oneshot::Receiver<HostToolResult>>,
) -> Value {
    let shared = match shared {
        None => Err(NO_WINDOW.to_string()),
        Some(rx) => match tokio::time::timeout(SHARED_LIST_TIMEOUT, rx).await {
            Ok(Ok(HostToolResult {
                error: None,
                mut result,
                ..
            })) => {
                prefix_shared_ids(&mut result);
                match result {
                    Value::Array(rows) => Ok(rows),
                    other => Err(format!("the app answered with {other}, not a list")),
                }
            }
            Ok(Ok(HostToolResult {
                error: Some(message),
                ..
            })) => Err(format!("the shared prompts could not be read: {message}")),
            Ok(Err(_)) | Err(_) => {
                Err("the Maestro app did not answer for the shared prompts".into())
            }
        },
    };
    let mut prompts = Vec::new();
    let mut result = serde_json::Map::new();
    match project {
        Ok(mut project) => {
            if let Some(Value::Array(rows)) = project.get_mut("prompts").map(Value::take) {
                prompts = rows;
            }
        }
        Err(note) => {
            result.insert("project_unavailable".into(), json!(note));
        }
    }
    match shared {
        Ok(rows) => prompts.extend(rows),
        Err(note) => {
            result.insert("shared_unavailable".into(), json!(note));
        }
    }
    result.insert("prompts".into(), Value::Array(prompts));
    Value::Object(result)
}

/// One prompt tool on the project's collection, answered from the store. Every lookup is scoped to
/// the session's project, so an id from another project's collection finds nothing.
async fn project_prompt_tool(
    store: Option<Store>,
    project_path: Option<String>,
    call: &HostToolCall,
    stdout: &crate::ClientOut,
) -> Result<Value, String> {
    let project_path = project_path
        .ok_or_else(|| "this session is not attached to a Maestro project".to_string())?;
    let store = store.ok_or_else(|| crate::project_store::UNAVAILABLE.to_string())?;
    let project_path = crate::project_path::canonical_project_path(&project_path);
    let (result, changed) = {
        let conn = store.lock().await;
        project_prompt(&conn, &project_path, &call.name, &call.arguments)?
    };
    if changed {
        crate::helpers::broadcast(
            stdout,
            ServerResponse::PromptsChanged(ProjectRef { project_path }),
        )
        .await;
    }
    Ok(result)
}

/// The result, and whether the collection changed.
fn project_prompt(
    conn: &Connection,
    project_path: &str,
    name: &str,
    arguments: &Value,
) -> Result<(Value, bool), String> {
    use crate::prompt_store;
    let id = || match parse_prompt_id(arguments)? {
        PromptId::Project(id) => Ok(id),
        PromptId::Shared(_) => Err(UNEXPECTED_PROMPT.to_string()),
    };
    let visible = |id: i32| {
        prompt_store::get(conn, project_path, id)?
            .ok_or_else(|| format!("no prompt project-{id} in this project"))
    };
    Ok(match name {
        "list_prompts" => {
            let tag = string_argument(arguments, "tag")?;
            let rows: Vec<Value> = prompt_store::list(conn, project_path)?
                .iter()
                .filter(|prompt| tag.as_ref().is_none_or(|tag| prompt.tags.contains(tag)))
                .map(|prompt| {
                    json!({
                        "id": format!("project-{}", prompt.id),
                        "title": prompt.title,
                        "tags": prompt.tags,
                        "favorite": prompt.favorite,
                    })
                })
                .collect();
            (json!({ "prompts": rows }), false)
        }
        "get_prompt" => (prompt_json(&visible(id()?)?), false),
        "create_prompt" => {
            let request = maestro_protocol::CreatePromptRequest {
                project_path: project_path.to_string(),
                title: string_argument(arguments, "title")?.unwrap_or_default(),
                body: string_argument(arguments, "body")?.unwrap_or_default(),
                tags: string_list_argument(arguments, "tags")?.unwrap_or_default(),
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(false),
            };
            (prompt_json(&prompt_store::create(conn, &request)?), true)
        }
        // Partial, as the host's was: what the agent leaves out keeps its value. The store's update
        // replaces title, body and tags together, so the gap is filled from the row first, under the
        // same lock. The favorite is not an edit and goes on its own.
        "update_prompt" => {
            let mut prompt = visible(id()?)?;
            let title = string_argument(arguments, "title")?;
            let body = string_argument(arguments, "body")?;
            let tags = string_list_argument(arguments, "tags")?;
            let favorite = bool_argument(arguments, "favorite")?;
            if title.is_some() || body.is_some() || tags.is_some() {
                let request = maestro_protocol::UpdatePromptRequest {
                    project_path: project_path.to_string(),
                    prompt_id: prompt.id,
                    title: title.unwrap_or(prompt.title),
                    body: body.unwrap_or(prompt.body),
                    tags: tags.unwrap_or(prompt.tags),
                };
                prompt = prompt_store::update(conn, &request)?;
            }
            if let Some(favorite) = favorite {
                prompt = prompt_store::set_favorite(conn, project_path, prompt.id, favorite)?;
            }
            (prompt_json(&prompt), true)
        }
        "delete_prompt" => {
            let id = id()?;
            if !prompt_store::delete(conn, project_path, id)? {
                return Err(format!("no prompt project-{id} in this project"));
            }
            (json!({ "deleted": format!("project-{id}") }), true)
        }
        other => return Err(format!("unknown Maestro tool: {other}")),
    })
}

const UNEXPECTED_PROMPT: &str = "a shared prompt reached the project's collection";

fn prompt_json(prompt: &maestro_protocol::Prompt) -> Value {
    json!({
        "id": format!("project-{}", prompt.id),
        "title": prompt.title,
        "body": prompt.body,
        "tags": prompt.tags,
        "favorite": prompt.favorite,
        "created_at": prompt.created_at,
        "updated_at": prompt.updated_at,
    })
}
