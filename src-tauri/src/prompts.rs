//! Prompts: text the user keeps to paste into an agent. Two collections, and nothing syncs them.
//!
//! A project's collection is in its daemon, so every app opening the project sees it; those
//! commands are one round trip through `query_project_store`. The shared collection is the app's
//! `prompts` table, the rows whose `project_id` is NULL, so it is listed in every project this app
//! opens. Rows with a `project_id` are project prompts from earlier builds, left for the phase 4
//! import and read by nothing here. Moving a prompt between the two is a copy: a new row in the
//! other collection, unstarred, with no link to the original.

use maestro_protocol::{
    CreatePromptRequest, ProjectRef, PromptRef, SetPromptFavoriteRequest, UpdatePromptRequest,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Prompt {
    /// Unique within its collection only: the two stores mint ids independently.
    pub id: i32,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    /// In the app's shared collection rather than the project's.
    pub shared: bool,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<maestro_protocol::Prompt> for Prompt {
    fn from(prompt: maestro_protocol::Prompt) -> Self {
        Prompt {
            id: prompt.id,
            title: prompt.title,
            body: prompt.body,
            tags: prompt.tags,
            shared: false,
            favorite: prompt.favorite,
            created_at: prompt.created_at,
            updated_at: prompt.updated_at,
        }
    }
}

/// What the editor sends. `id` is `None` for a new prompt, and `shared` names the collection it is
/// saved in; saving never moves a prompt between collections.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PromptInput {
    pub id: Option<i32>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub shared: bool,
    pub favorite: bool,
}

const COLUMNS: &str = "id, title, body, tags, favorite, created_at, updated_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Prompt> {
    let tags: String = row.get(3)?;
    Ok(Prompt {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        // A malformed column costs the prompt its tags, not the whole list.
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        shared: true,
        favorite: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn read(conn: &Connection, id: i32) -> Result<Option<Prompt>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM prompts WHERE id = ?1 AND project_id IS NULL"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read prompt: {}", e))
}

fn read_existing(conn: &Connection, id: i32) -> Result<Prompt, String> {
    read(conn, id)?.ok_or_else(|| "That prompt no longer exists".into())
}

/// The shared collection, favorites first, then most recently edited, as the daemon orders a
/// project's.
fn list(conn: &Connection) -> Result<Vec<Prompt>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM prompts WHERE project_id IS NULL \
             ORDER BY favorite DESC, updated_at DESC, id DESC"
        ))
        .map_err(|e| format!("Failed to list prompts: {}", e))?;
    let rows = statement
        .query_map([], from_row)
        .map_err(|e| format!("Failed to list prompts: {}", e))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| format!("Failed to list prompts: {}", e))
}

/// Insert into the shared collection when `input.id` is `None`, replace otherwise. `input.shared`
/// is not read: the caller has already chosen this collection.
fn save(conn: &Connection, input: &PromptInput) -> Result<Prompt, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("A prompt needs a title".into());
    }
    if input.body.trim().is_empty() {
        return Err("A prompt needs some text".into());
    }
    let mut tags: Vec<String> = Vec::new();
    for tag in &input.tags {
        let tag = tag.trim().to_lowercase();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    let tags = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    let id = match input.id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE prompts SET title = ?1, body = ?2, tags = ?3, favorite = ?4, \
                     updated_at = ?5 WHERE id = ?6 AND project_id IS NULL",
                    params![title, input.body, tags, input.favorite, now, id],
                )
                .map_err(|e| format!("Failed to save prompt: {}", e))?;
            if changed == 0 {
                return Err("That prompt no longer exists".into());
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO prompts (project_id, title, body, tags, favorite, created_at, \
                 updated_at) VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?5)",
                params![title, input.body, tags, input.favorite, now],
            )
            .map_err(|e| format!("Failed to save prompt: {}", e))?;
            conn.last_insert_rowid() as i32
        }
    };
    read_existing(conn, id)
}

/// Not an edit, so it leaves `updated_at` and the order among the favorites alone.
fn set_favorite(conn: &Connection, id: i32, favorite: bool) -> Result<Prompt, String> {
    conn.execute(
        "UPDATE prompts SET favorite = ?1 WHERE id = ?2 AND project_id IS NULL",
        params![favorite, id],
    )
    .map_err(|e| format!("Failed to update prompt: {}", e))?;
    read_existing(conn, id)
}

fn delete(conn: &Connection, id: i32) -> Result<(), String> {
    conn.execute(
        "DELETE FROM prompts WHERE id = ? AND project_id IS NULL",
        [id],
    )
    .map(|_| ())
    .map_err(|e| format!("Failed to delete prompt: {}", e))
}

/// A copy lands unstarred: it is a new prompt in the other collection, not the same one moved.
fn copy_input(prompt: Prompt, shared: bool) -> PromptInput {
    PromptInput {
        id: None,
        title: prompt.title,
        body: prompt.body,
        tags: prompt.tags,
        shared,
        favorite: false,
    }
}

/// Answer one of the agent's prompt tools for the shared collection. The gateway answers a
/// project's collection itself and forwards only the shared ones here, with the bare integer id;
/// it prefixes the ids this returns with `shared-`.
pub(crate) fn tool(conn: &Connection, name: &str, arguments: &Value) -> Result<Value, String> {
    let json = |value: &Prompt| serde_json::to_value(value).map_err(|e| e.to_string());
    let existing = |id: i32| read(conn, id)?.ok_or_else(|| format!("no shared prompt {id}"));
    match name {
        "list_prompts" => {
            let tag = arguments.get("tag").and_then(Value::as_str);
            Ok(Value::Array(
                list(conn)?
                    .iter()
                    .filter(|prompt| tag.is_none_or(|tag| prompt.tags.iter().any(|t| t == tag)))
                    .map(|prompt| {
                        json!({
                            "id": prompt.id,
                            "title": prompt.title,
                            "tags": prompt.tags,
                            "favorite": prompt.favorite,
                        })
                    })
                    .collect(),
            ))
        }
        "get_prompt" => json(&existing(id_argument(arguments)?)?),
        "create_prompt" => {
            let input = PromptInput {
                id: None,
                title: string_argument(arguments, "title")?.unwrap_or_default(),
                body: string_argument(arguments, "body")?.unwrap_or_default(),
                tags: tags_argument(arguments)?.unwrap_or_default(),
                shared: true,
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(false),
            };
            json(&save(conn, &input)?)
        }
        "update_prompt" => {
            let current = existing(id_argument(arguments)?)?;
            let input = PromptInput {
                id: Some(current.id),
                title: string_argument(arguments, "title")?.unwrap_or(current.title),
                body: string_argument(arguments, "body")?.unwrap_or(current.body),
                tags: tags_argument(arguments)?.unwrap_or(current.tags),
                shared: true,
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(current.favorite),
            };
            json(&save(conn, &input)?)
        }
        "delete_prompt" => {
            let prompt = existing(id_argument(arguments)?)?;
            delete(conn, prompt.id)?;
            Ok(json!({ "deleted": prompt.id }))
        }
        other => Err(format!("unknown Maestro tool: {other}")),
    }
}

fn id_argument(arguments: &Value) -> Result<i32, String> {
    arguments
        .get("id")
        .and_then(Value::as_i64)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| "id is required".to_string())
}

// Absent and null both mean "leave it"; a value of the wrong type is refused with the field's
// name rather than coerced, since nothing validates a host tool's schema before it gets here.
fn string_argument(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn bool_argument(arguments: &Value, key: &str) -> Result<Option<bool>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

fn tags_argument(arguments: &Value) -> Result<Option<Vec<String>>, String> {
    match arguments.get("tags") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| "tags must be a list of strings".to_string()),
    }
}

/// Run `f` against the shared collection. A write tells every listener the shared collection
/// changed with `prompts-changed` and `project_id: null`, where the daemon's push names a project.
pub(crate) fn with_shared<T>(
    app_state: &AppState,
    write: bool,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let result = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        f(&conn)?
    };
    if write {
        crate::core::emit_or_log(
            &app_state.app_handle,
            "prompts-changed",
            json!({ "project_id": null }),
        );
    }
    Ok(result)
}

async fn create_project_prompt(
    app_state: &Arc<AppState>,
    project_id: i32,
    input: PromptInput,
) -> Result<Prompt, String> {
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::CreatePrompt(CreatePromptRequest {
                project_path,
                title: input.title,
                body: input.body,
                tags: input.tags,
                favorite: input.favorite,
            })
        },
        reply!(ServerResponse::CreatePromptOk(prompt) => prompt.into()),
    )
    .await
}

async fn set_project_favorite(
    app_state: &Arc<AppState>,
    project_id: i32,
    prompt_id: i32,
    favorite: bool,
) -> Result<Prompt, String> {
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::SetPromptFavorite(SetPromptFavoriteRequest {
                project_path,
                prompt_id,
                favorite,
            })
        },
        reply!(ServerResponse::SetPromptFavoriteOk(prompt) => prompt.into()),
    )
    .await
}

/// One collection: the app's shared one, or the project's from its daemon. Favorites first, then
/// most recently edited.
#[tauri::command]
#[specta::specta]
pub async fn list_prompts(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    shared: bool,
) -> Result<Vec<Prompt>, String> {
    if shared {
        return with_shared(&app_state, false, list);
    }
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| ServerRequest::ListPrompts(ProjectRef { project_path }),
        reply!(ServerResponse::ListPromptsOk(list) => list),
    )
    .await?;
    Ok(list.prompts.into_iter().map(Into::into).collect())
}

/// Create a prompt in the collection `prompt.shared` names, or replace the one `prompt.id` names
/// there.
#[tauri::command]
#[specta::specta]
pub async fn save_prompt(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    prompt: PromptInput,
) -> Result<Prompt, String> {
    if prompt.shared {
        return with_shared(&app_state, true, |conn| save(conn, &prompt));
    }
    let Some(prompt_id) = prompt.id else {
        return create_project_prompt(&app_state, project_id, prompt).await;
    };
    let favorite = prompt.favorite;
    let saved: Prompt = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::UpdatePrompt(UpdatePromptRequest {
                project_path,
                prompt_id,
                title: prompt.title,
                body: prompt.body,
                tags: prompt.tags,
            })
        },
        reply!(ServerResponse::UpdatePromptOk(prompt) => prompt.into()),
    )
    .await?;
    // An edit leaves the star alone on the daemon, so the editor's star is a request of its own.
    if saved.favorite == favorite {
        return Ok(saved);
    }
    set_project_favorite(&app_state, project_id, prompt_id, favorite).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_prompt_favorite(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    id: i32,
    shared: bool,
    favorite: bool,
) -> Result<Prompt, String> {
    if shared {
        return with_shared(&app_state, true, |conn| set_favorite(conn, id, favorite));
    }
    set_project_favorite(&app_state, project_id, id, favorite).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_prompt(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    id: i32,
    shared: bool,
) -> Result<(), String> {
    if shared {
        return with_shared(&app_state, true, |conn| delete(conn, id));
    }
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::DeletePrompt(PromptRef {
                project_path,
                prompt_id: id,
            })
        },
        reply!(ServerResponse::DeletePromptOk => ()),
    )
    .await
}

/// Copy a prompt into the other collection: from the shared one (`shared`) into the project's, or
/// back. The copy is a new, unstarred row; the original stays, and nothing links the two.
#[tauri::command]
#[specta::specta]
pub async fn copy_prompt(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    id: i32,
    shared: bool,
) -> Result<Prompt, String> {
    if shared {
        let source = with_shared(&app_state, false, |conn| read_existing(conn, id))?;
        return create_project_prompt(&app_state, project_id, copy_input(source, false)).await;
    }
    let source = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::GetPrompt(PromptRef {
                project_path,
                prompt_id: id,
            })
        },
        reply!(ServerResponse::GetPromptOk(found) => found.prompt),
    )
    .await?
    .ok_or("That prompt no longer exists")?;
    with_shared(&app_state, true, |conn| {
        save(conn, &copy_input(source.into(), true))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str) -> PromptInput {
        PromptInput {
            id: None,
            title: title.into(),
            body: "Do the thing.".into(),
            tags: vec![" Review ".into(), "review".into(), "".into(), "rust".into()],
            shared: true,
            favorite: false,
        }
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'p', '/p1', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn
    }

    fn titles(conn: &Connection) -> Vec<String> {
        list(conn).unwrap().into_iter().map(|p| p.title).collect()
    }

    #[test]
    fn the_shared_collection_ignores_rows_left_by_earlier_builds() {
        let conn = setup();
        let saved = save(&conn, &input(" Mine ")).unwrap();
        assert_eq!(saved.title, "Mine");
        assert_eq!(saved.tags, vec!["review", "rust"]);
        assert!(saved.shared);
        conn.execute(
            "INSERT INTO prompts (id, project_id, title, body, created_at, updated_at) \
             VALUES (99, 1, 'old project prompt', 'b', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        assert_eq!(titles(&conn), vec!["Mine"]);
        assert!(read(&conn, 99).unwrap().is_none());
        assert!(set_favorite(&conn, 99, true).is_err());
        delete(&conn, 99).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompts WHERE id = 99", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 1, "the phase 4 import still needs it");
    }

    #[test]
    fn favorites_sort_first_and_starring_does_not_touch_updated_at() {
        let conn = setup();
        let older = save(&conn, &input("Older")).unwrap();
        save(&conn, &input("Newer")).unwrap();
        let starred = set_favorite(&conn, older.id, true).unwrap();
        assert!(starred.favorite);
        assert_eq!(starred.updated_at, older.updated_at);
        assert_eq!(titles(&conn), vec!["Older", "Newer"]);
    }

    #[test]
    fn a_copy_is_a_new_unstarred_prompt() {
        let conn = setup();
        let mut starred = input("Star");
        starred.favorite = true;
        let original = save(&conn, &starred).unwrap();
        let copy = save(&conn, &copy_input(original.clone(), true)).unwrap();
        assert_ne!(copy.id, original.id);
        assert!(!copy.favorite);
        assert_eq!(copy.body, original.body);
        assert_eq!(titles(&conn), vec!["Star", "Star"]);
    }

    #[test]
    fn rejects_empty_fields_and_missing_prompts() {
        let conn = setup();
        assert!(save(&conn, &input("  ")).is_err());
        let mut empty = input("Title");
        empty.body = " ".into();
        assert!(save(&conn, &empty).is_err());
        let mut gone = input("Gone");
        gone.id = Some(999);
        assert!(save(&conn, &gone).is_err());
    }

    #[test]
    fn the_agent_tools_answer_for_the_shared_collection() {
        let conn = setup();
        conn.execute(
            "INSERT INTO prompts (id, project_id, title, body, created_at, updated_at) \
             VALUES (99, 1, 'old project prompt', 'b', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let created = tool(
            &conn,
            "create_prompt",
            &json!({ "title": "Mine", "body": "Do it.", "tags": ["Review"], "favorite": true }),
        )
        .unwrap();
        let id = created["id"].as_i64().unwrap();
        assert_eq!(created["tags"], json!(["review"]));
        assert_eq!(created["shared"], true);
        save(&conn, &input("Other")).unwrap();

        let listed = tool(&conn, "list_prompts", &json!({})).unwrap();
        let titles: Vec<_> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap())
            .collect();
        assert_eq!(titles, vec!["Mine", "Other"]);
        assert!(listed[0].get("body").is_none());
        let tagged = tool(&conn, "list_prompts", &json!({ "tag": "rust" })).unwrap();
        assert_eq!(tagged.as_array().unwrap().len(), 1);

        for name in ["get_prompt", "update_prompt", "delete_prompt"] {
            let error = tool(&conn, name, &json!({ "id": 99 })).unwrap_err();
            assert_eq!(error, "no shared prompt 99");
        }

        let updated = tool(
            &conn,
            "update_prompt",
            &json!({ "id": id, "body": "Do it better." }),
        )
        .unwrap();
        assert_eq!(updated["title"], "Mine");
        assert_eq!(updated["body"], "Do it better.");
        assert_eq!(updated["favorite"], true);
        assert!(tool(
            &conn,
            "update_prompt",
            &json!({ "id": id, "favorite": "yes" })
        )
        .is_err());

        tool(&conn, "delete_prompt", &json!({ "id": id })).unwrap();
        assert!(tool(&conn, "get_prompt", &json!({ "id": id })).is_err());
    }
}
