//! Prompts: text the user keeps to paste into an agent, one project's or shared by all of them.
//!
//! Stored in the app's own database rather than the project's `.maestro/`, because a shared prompt
//! belongs to no project and has to be there on every connection. A NULL `project_id` is what
//! "shared" means. Favorites are per project, in `prompt_favorites`: a shared prompt starred in one
//! project is not starred in the others.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Prompt {
    pub id: i32,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    /// Listed in every project rather than only the one it was saved in.
    pub shared: bool,
    /// Starred in the project it was read for.
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// What the editor sends. `id` is `None` for a new prompt.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PromptInput {
    pub id: Option<i32>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub shared: bool,
    /// Starred in the project it is saved from. Other projects' stars are left alone.
    pub favorite: bool,
}

/// `?1` is the project the favorite flag is read for.
const COLUMNS: &str = "id, title, body, tags, project_id IS NULL, \
     EXISTS (SELECT 1 FROM prompt_favorites f WHERE f.prompt_id = prompts.id AND f.project_id = ?1), \
     created_at, updated_at";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Prompt> {
    let tags: String = row.get(3)?;
    Ok(Prompt {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        // A malformed column costs the prompt its tags, not the whole list.
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        shared: row.get(4)?,
        favorite: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// A prompt `project_id` can see: its own, or a shared one.
fn read(conn: &Connection, project_id: i32, id: i32) -> Result<Option<Prompt>, String> {
    conn.query_row(
        &format!(
            "SELECT {COLUMNS} FROM prompts WHERE id = ?2 AND (project_id = ?1 OR project_id IS NULL)"
        ),
        [project_id, id],
        from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read prompt: {}", e))
}

/// The project's own prompts and every shared one, most recently edited first.
fn list(conn: &Connection, project_id: i32) -> Result<Vec<Prompt>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM prompts WHERE project_id = ?1 OR project_id IS NULL \
             ORDER BY updated_at DESC, id DESC"
        ))
        .map_err(|e| format!("Failed to list prompts: {}", e))?;
    let rows = statement
        .query_map([project_id], from_row)
        .map_err(|e| format!("Failed to list prompts: {}", e))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| format!("Failed to list prompts: {}", e))
}

/// Insert when `input.id` is `None`, replace otherwise. Unsharing a prompt gives it to the project
/// it was unshared from, which is the only project the user is looking at when they do it.
fn save(conn: &Connection, project_id: i32, input: &PromptInput) -> Result<Prompt, String> {
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
    let owner = (!input.shared).then_some(project_id);
    let now = chrono::Utc::now().to_rfc3339();

    let id = match input.id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE prompts SET title = ?1, body = ?2, tags = ?3, updated_at = ?4 \
                     WHERE id = ?5",
                    params![title, input.body, tags, now, id],
                )
                .map_err(|e| format!("Failed to save prompt: {}", e))?;
            if changed == 0 {
                return Err("That prompt no longer exists".into());
            }
            set_shared(conn, project_id, id, input.shared)?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO prompts (project_id, title, body, tags, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![owner, title, input.body, tags, now],
            )
            .map_err(|e| format!("Failed to save prompt: {}", e))?;
            conn.last_insert_rowid() as i32
        }
    };
    set_favorite(conn, project_id, id, input.favorite)
}

/// Share with every project, or give the prompt to `project_id` alone. Not an edit, so it leaves
/// `updated_at` and the list order alone.
fn set_shared(conn: &Connection, project_id: i32, id: i32, shared: bool) -> Result<(), String> {
    let owner = (!shared).then_some(project_id);
    let changed = conn
        .execute(
            "UPDATE prompts SET project_id = ?1 WHERE id = ?2",
            params![owner, id],
        )
        .map_err(|e| format!("Failed to update prompt: {}", e))?;
    if changed == 0 {
        return Err("That prompt no longer exists".into());
    }
    // Projects that can no longer see it must not keep a star they cannot remove.
    if let Some(owner) = owner {
        conn.execute(
            "DELETE FROM prompt_favorites WHERE prompt_id = ?1 AND project_id != ?2",
            params![id, owner],
        )
        .map_err(|e| format!("Failed to update prompt: {}", e))?;
    }
    Ok(())
}

/// Star or unstar for one project. Not an edit, so it leaves `updated_at` and the list order alone.
fn set_favorite(
    conn: &Connection,
    project_id: i32,
    id: i32,
    favorite: bool,
) -> Result<Prompt, String> {
    let statement = if favorite {
        "INSERT OR IGNORE INTO prompt_favorites (prompt_id, project_id) VALUES (?1, ?2)"
    } else {
        "DELETE FROM prompt_favorites WHERE prompt_id = ?1 AND project_id = ?2"
    };
    conn.execute(statement, params![id, project_id])
        .map_err(|e| format!("Failed to update prompt: {}", e))?;
    read(conn, project_id, id)?.ok_or_else(|| "That prompt no longer exists".into())
}

fn delete(conn: &Connection, id: i32) -> Result<(), String> {
    conn.execute("DELETE FROM prompts WHERE id = ?", [id])
        .map(|_| ())
        .map_err(|e| format!("Failed to delete prompt: {}", e))
}

/// Answer one of the agent's prompt tools, for the project its session belongs to. Ids are
/// small integers, so every lookup goes through `read`, which only finds a prompt that project
/// can see.
pub(crate) fn tool(
    conn: &Connection,
    project_id: i32,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let json = |value: &Prompt| serde_json::to_value(value).map_err(|e| e.to_string());
    let visible = |id: i32| {
        read(conn, project_id, id)?.ok_or_else(|| format!("no prompt {id} in this project"))
    };
    match name {
        "list_prompts" => {
            let tag = arguments.get("tag").and_then(Value::as_str);
            let mut prompts: Vec<Prompt> = list(conn, project_id)?
                .into_iter()
                .filter(|prompt| tag.is_none_or(|tag| prompt.tags.iter().any(|t| t == tag)))
                .collect();
            prompts.sort_by_key(|prompt| !prompt.favorite);
            Ok(Value::Array(
                prompts
                    .iter()
                    .map(|prompt| {
                        json!({
                            "id": prompt.id,
                            "title": prompt.title,
                            "tags": prompt.tags,
                            "shared": prompt.shared,
                            "favorite": prompt.favorite,
                        })
                    })
                    .collect(),
            ))
        }
        "get_prompt" => json(&visible(id_argument(arguments)?)?),
        "create_prompt" => {
            let input = PromptInput {
                id: None,
                title: string_argument(arguments, "title")?.unwrap_or_default(),
                body: string_argument(arguments, "body")?.unwrap_or_default(),
                tags: tags_argument(arguments)?.unwrap_or_default(),
                shared: bool_argument(arguments, "shared")?.unwrap_or(false),
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(false),
            };
            json(&save(conn, project_id, &input)?)
        }
        "update_prompt" => {
            let current = visible(id_argument(arguments)?)?;
            let input = PromptInput {
                id: Some(current.id),
                title: string_argument(arguments, "title")?.unwrap_or(current.title),
                body: string_argument(arguments, "body")?.unwrap_or(current.body),
                tags: tags_argument(arguments)?.unwrap_or(current.tags),
                shared: bool_argument(arguments, "shared")?.unwrap_or(current.shared),
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(current.favorite),
            };
            json(&save(conn, project_id, &input)?)
        }
        "delete_prompt" => {
            let prompt = visible(id_argument(arguments)?)?;
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

fn db(app_state: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn list_prompts(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Prompt>, String> {
    list(&*db(&app_state)?, project_id)
}

/// Create a prompt, or replace the one `prompt.id` names.
#[tauri::command]
#[specta::specta]
pub fn save_prompt(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    prompt: PromptInput,
) -> Result<Prompt, String> {
    save(&*db(&app_state)?, project_id, &prompt)
}

#[tauri::command]
#[specta::specta]
pub fn set_prompt_favorite(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    id: i32,
    favorite: bool,
) -> Result<Prompt, String> {
    set_favorite(&*db(&app_state)?, project_id, id, favorite)
}

#[tauri::command]
#[specta::specta]
pub fn set_prompt_shared(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    id: i32,
    shared: bool,
) -> Result<Prompt, String> {
    let conn = db(&app_state)?;
    set_shared(&conn, project_id, id, shared)?;
    read(&conn, project_id, id)?.ok_or_else(|| "That prompt no longer exists".into())
}

#[tauri::command]
#[specta::specta]
pub fn delete_prompt(app_state: State<Arc<AppState>>, id: i32) -> Result<(), String> {
    delete(&*db(&app_state)?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(title: &str, shared: bool) -> PromptInput {
        PromptInput {
            id: None,
            title: title.into(),
            body: "Do the thing.".into(),
            tags: vec![" Review ".into(), "review".into(), "".into(), "rust".into()],
            shared,
            favorite: false,
        }
    }

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();
        for id in [1, 2] {
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, updated_at) \
                 VALUES (?1, 'p', ?2, '2026-01-01', '2026-01-01')",
                params![id, format!("/p{id}")],
            )
            .unwrap();
        }
        conn
    }

    fn titles(conn: &Connection, project_id: i32) -> Vec<String> {
        list(conn, project_id)
            .unwrap()
            .into_iter()
            .map(|p| p.title)
            .collect()
    }

    #[test]
    fn a_project_sees_its_own_prompts_and_shared_ones() {
        let conn = setup();
        let own = save(&conn, 1, &input(" Mine ", false)).unwrap();
        assert_eq!(own.title, "Mine");
        assert_eq!(own.tags, vec!["review", "rust"]);
        assert!(!own.shared);
        save(&conn, 2, &input("Theirs", false)).unwrap();
        save(&conn, 2, &input("Everyone's", true)).unwrap();

        assert_eq!(titles(&conn, 1), vec!["Everyone's", "Mine"]);
        assert_eq!(titles(&conn, 2), vec!["Everyone's", "Theirs"]);
    }

    #[test]
    fn unsharing_gives_the_prompt_to_the_current_project() {
        let conn = setup();
        let shared = save(&conn, 2, &input("Shared", true)).unwrap();
        let mut edit = input("Shared", false);
        edit.id = Some(shared.id);
        save(&conn, 1, &edit).unwrap();

        assert_eq!(titles(&conn, 1), vec!["Shared"]);
        assert!(titles(&conn, 2).is_empty());
    }

    #[test]
    fn favorite_does_not_touch_updated_at() {
        let conn = setup();
        let prompt = save(&conn, 1, &input("Star me", false)).unwrap();
        let starred = set_favorite(&conn, 1, prompt.id, true).unwrap();
        assert!(starred.favorite);
        assert_eq!(starred.updated_at, prompt.updated_at);
    }

    #[test]
    fn sharing_does_not_touch_updated_at() {
        let conn = setup();
        let prompt = save(&conn, 1, &input("Share me", false)).unwrap();
        set_shared(&conn, 1, prompt.id, true).unwrap();
        let shared = read(&conn, 2, prompt.id).unwrap().unwrap();
        assert!(shared.shared);
        assert_eq!(shared.updated_at, prompt.updated_at);
        assert!(set_shared(&conn, 1, 999, true).is_err());
    }

    fn favorites(conn: &Connection, project_id: i32) -> Vec<String> {
        list(conn, project_id)
            .unwrap()
            .into_iter()
            .filter(|p| p.favorite)
            .map(|p| p.title)
            .collect()
    }

    #[test]
    fn a_shared_prompt_is_starred_per_project() {
        let conn = setup();
        let mut starred = input("Shared", true);
        starred.favorite = true;
        let shared = save(&conn, 1, &starred).unwrap();
        assert!(shared.favorite);
        assert_eq!(favorites(&conn, 1), vec!["Shared"]);
        assert!(favorites(&conn, 2).is_empty());

        // Saving from project 2 without a star leaves project 1's alone.
        let mut edit = input("Shared", true);
        edit.id = Some(shared.id);
        save(&conn, 2, &edit).unwrap();
        assert_eq!(favorites(&conn, 1), vec!["Shared"]);

        // Unsharing into project 2 drops the star project 1 can no longer see, even once reshared.
        edit.shared = false;
        edit.favorite = true;
        save(&conn, 2, &edit).unwrap();
        edit.shared = true;
        save(&conn, 2, &edit).unwrap();
        assert!(favorites(&conn, 1).is_empty());
        assert_eq!(favorites(&conn, 2), vec!["Shared"]);
    }

    #[test]
    fn rejects_empty_fields_and_missing_prompts() {
        let conn = setup();
        assert!(save(&conn, 1, &input("  ", false)).is_err());
        let mut empty = input("Title", false);
        empty.body = " ".into();
        assert!(save(&conn, 1, &empty).is_err());
        let mut gone = input("Gone", false);
        gone.id = Some(999);
        assert!(save(&conn, 1, &gone).is_err());
    }

    #[test]
    fn the_agent_tools_are_scoped_to_the_project() {
        let conn = setup();
        let theirs = save(&conn, 2, &input("Theirs", false)).unwrap();
        let created = tool(
            &conn,
            1,
            "create_prompt",
            &json!({ "title": "Mine", "body": "Do it.", "tags": ["Review"], "favorite": true }),
        )
        .unwrap();
        let id = created["id"].as_i64().unwrap();
        assert_eq!(created["tags"], json!(["review"]));
        save(&conn, 1, &input("Shared", true)).unwrap();

        let listed = tool(&conn, 1, "list_prompts", &json!({})).unwrap();
        let titles: Vec<_> = listed
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap())
            .collect();
        // Favorites first, and nothing of project 2's.
        assert_eq!(titles, vec!["Mine", "Shared"]);
        assert!(listed[0].get("body").is_none());
        let tagged = tool(&conn, 1, "list_prompts", &json!({ "tag": "review" })).unwrap();
        assert_eq!(tagged.as_array().unwrap().len(), 2);

        for name in ["get_prompt", "update_prompt", "delete_prompt"] {
            let error = tool(&conn, 1, name, &json!({ "id": theirs.id })).unwrap_err();
            assert_eq!(error, format!("no prompt {} in this project", theirs.id));
        }

        let updated = tool(
            &conn,
            1,
            "update_prompt",
            &json!({ "id": id, "body": "Do it better." }),
        )
        .unwrap();
        assert_eq!(updated["title"], "Mine");
        assert_eq!(updated["body"], "Do it better.");
        assert_eq!(updated["favorite"], true);
        assert!(tool(
            &conn,
            1,
            "update_prompt",
            &json!({ "id": id, "shared": "yes" })
        )
        .is_err());

        tool(&conn, 1, "delete_prompt", &json!({ "id": id })).unwrap();
        assert!(tool(&conn, 1, "get_prompt", &json!({ "id": id })).is_err());
    }

    #[test]
    fn deleting_a_project_takes_its_prompts_but_not_shared_ones() {
        let conn = setup();
        save(&conn, 1, &input("Own", false)).unwrap();
        save(&conn, 1, &input("Shared", true)).unwrap();
        conn.execute("DELETE FROM projects WHERE id = 1", [])
            .unwrap();
        assert_eq!(titles(&conn, 2), vec!["Shared"]);

        let prompt = save(&conn, 2, &input("Bye", false)).unwrap();
        delete(&conn, prompt.id).unwrap();
        assert_eq!(titles(&conn, 2), vec!["Shared"]);
    }
}
