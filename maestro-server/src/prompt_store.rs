//! A project's prompt collection, kept in `projects.db` so every app opening the project sees it.
//!
//! The shared collection stays in the app's own database; the two are separate stores and nothing
//! syncs them, so copying a prompt across is a create on the other side.
//!
//! A prompt is `(project_path, id)`, with ids minted per project from a counter that never goes
//! back, beside the task and worktree counters. The favorite flag is a column on the row, and
//! setting it is not an edit: it leaves `updated_at`, and so the list order, alone.

use chrono::Utc;
use maestro_protocol::{
    CreatePromptRequest, OptionalPrompt, ProjectRef, Prompt, PromptList, ServerRequest,
    ServerResponse, UpdatePromptRequest,
};
use rusqlite::{params, Connection, OptionalExtension};

use crate::automations::canonical_project_path;

/// Version 4 of `projects.db`: the prompt collection. Frozen: a later change to this table is a
/// new entry in `project_store::MIGRATIONS`.
pub const V4_PROMPTS: &str = "
-- The highest prompt id a project has ever minted, beside its task and worktree counters.
ALTER TABLE project_counters ADD COLUMN last_prompt_id INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS prompts (
    project_path TEXT NOT NULL,
    id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_path, id)
);
";

const SELECT: &str =
    "SELECT id, project_path, title, body, tags, favorite, created_at, updated_at FROM prompts";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Prompt> {
    let tags: String = row.get("tags")?;
    Ok(Prompt {
        id: row.get("id")?,
        project_path: row.get("project_path")?,
        title: row.get("title")?,
        body: row.get("body")?,
        // A malformed column costs the prompt its tags, not the whole list.
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        favorite: row.get("favorite")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// The project's prompts, favorites first, then most recently edited.
pub fn list(conn: &Connection, project_path: &str) -> Result<Vec<Prompt>, String> {
    let fail = |e: rusqlite::Error| format!("Failed to list prompts: {e}");
    let mut statement = conn
        .prepare(&format!(
            "{SELECT} WHERE project_path = ?1 ORDER BY favorite DESC, updated_at DESC, id DESC"
        ))
        .map_err(fail)?;
    let rows = statement
        .query_map(params![project_path], from_row)
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    Ok(rows)
}

pub fn get(conn: &Connection, project_path: &str, id: i32) -> Result<Option<Prompt>, String> {
    conn.query_row(
        &format!("{SELECT} WHERE project_path = ?1 AND id = ?2"),
        params![project_path, id],
        from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read prompt {id}: {e}"))
}

fn existing(conn: &Connection, project_path: &str, id: i32) -> Result<Prompt, String> {
    get(conn, project_path, id)?.ok_or_else(|| "That prompt no longer exists".to_string())
}

/// The title, body and tags as the app's editor stored them: a title and some text are required,
/// and tags are trimmed, lowercased and deduplicated in order.
fn validate<'a>(title: &'a str, body: &str, tags: &[String]) -> Result<(&'a str, String), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("A prompt needs a title".into());
    }
    if body.trim().is_empty() {
        return Err("A prompt needs some text".into());
    }
    let mut clean: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_lowercase();
        if !tag.is_empty() && !clean.contains(&tag) {
            clean.push(tag);
        }
    }
    let tags = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
    Ok((title, tags))
}

fn mint_id(conn: &Connection, project_path: &str) -> Result<i32, String> {
    conn.query_row(
        "INSERT INTO project_counters (project_path, last_task_id, last_prompt_id)
         VALUES (?1, 0, 1)
         ON CONFLICT(project_path) DO UPDATE SET last_prompt_id = last_prompt_id + 1
         RETURNING last_prompt_id",
        params![project_path],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to mint a prompt id: {e}"))
}

pub fn create(conn: &Connection, request: &CreatePromptRequest) -> Result<Prompt, String> {
    let (title, tags) = validate(&request.title, &request.body, &request.tags)?;
    let id = mint_id(conn, &request.project_path)?;
    conn.execute(
        "INSERT INTO prompts (project_path, id, title, body, tags, favorite, created_at,
                              updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            request.project_path,
            id,
            title,
            request.body,
            tags,
            request.favorite,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| format!("Failed to save prompt: {e}"))?;
    existing(conn, &request.project_path, id)
}

pub fn update(conn: &Connection, request: &UpdatePromptRequest) -> Result<Prompt, String> {
    let (title, tags) = validate(&request.title, &request.body, &request.tags)?;
    conn.execute(
        "UPDATE prompts SET title = ?3, body = ?4, tags = ?5, updated_at = ?6
         WHERE project_path = ?1 AND id = ?2",
        params![
            request.project_path,
            request.prompt_id,
            title,
            request.body,
            tags,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| format!("Failed to save prompt: {e}"))?;
    existing(conn, &request.project_path, request.prompt_id)
}

pub fn set_favorite(
    conn: &Connection,
    project_path: &str,
    id: i32,
    favorite: bool,
) -> Result<Prompt, String> {
    conn.execute(
        "UPDATE prompts SET favorite = ?3 WHERE project_path = ?1 AND id = ?2",
        params![project_path, id, favorite],
    )
    .map_err(|e| format!("Failed to update prompt: {e}"))?;
    existing(conn, project_path, id)
}

/// `false` when the project had no such prompt.
pub fn delete(conn: &Connection, project_path: &str, id: i32) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM prompts WHERE project_path = ?1 AND id = ?2",
        params![project_path, id],
    )
    .map(|deleted| deleted > 0)
    .map_err(|e| format!("Failed to delete prompt: {e}"))
}

/// The reply to a prompt request, and the pushes to broadcast after it. The path is canonicalized
/// first, so two spellings of one project cannot split its collection or its id counter.
pub fn answer(
    conn: &Connection,
    request: ServerRequest,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    use ServerRequest as Q;
    use ServerResponse as A;
    let canonical = |path: &mut String| *path = canonical_project_path(path);

    let (project_path, reply, changed) = match request {
        Q::ListPrompts(mut r) => {
            canonical(&mut r.project_path);
            let prompts = list(conn, &r.project_path)?;
            (
                r.project_path,
                A::ListPromptsOk(PromptList { prompts }),
                false,
            )
        }
        Q::GetPrompt(mut r) => {
            canonical(&mut r.project_path);
            let prompt = get(conn, &r.project_path, r.prompt_id)?;
            (
                r.project_path,
                A::GetPromptOk(OptionalPrompt { prompt }),
                false,
            )
        }
        Q::CreatePrompt(mut r) => {
            canonical(&mut r.project_path);
            let prompt = create(conn, &r)?;
            (r.project_path, A::CreatePromptOk(prompt), true)
        }
        Q::UpdatePrompt(mut r) => {
            canonical(&mut r.project_path);
            let prompt = update(conn, &r)?;
            (r.project_path, A::UpdatePromptOk(prompt), true)
        }
        Q::SetPromptFavorite(mut r) => {
            canonical(&mut r.project_path);
            let prompt = set_favorite(conn, &r.project_path, r.prompt_id, r.favorite)?;
            (r.project_path, A::SetPromptFavoriteOk(prompt), true)
        }
        Q::DeletePrompt(mut r) => {
            canonical(&mut r.project_path);
            let deleted = delete(conn, &r.project_path, r.prompt_id)?;
            (r.project_path, A::DeletePromptOk, deleted)
        }
        _ => return Err("not a prompt request".to_string()),
    };

    let pushes = if changed {
        vec![A::PromptsChanged(ProjectRef { project_path })]
    } else {
        Vec::new()
    };
    Ok((reply, pushes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_store::open_in_memory;

    const PROJECT: &str = "/p";

    fn prompt(conn: &Connection, project_path: &str, title: &str) -> Prompt {
        create(
            conn,
            &CreatePromptRequest {
                project_path: project_path.to_string(),
                title: title.to_string(),
                body: "Do the thing".to_string(),
                tags: vec![" Review ".to_string(), "review".to_string(), String::new()],
                favorite: false,
            },
        )
        .expect("create a prompt")
    }

    fn edit(conn: &Connection, id: i32, title: &str) -> Prompt {
        update(
            conn,
            &UpdatePromptRequest {
                project_path: PROJECT.to_string(),
                prompt_id: id,
                title: title.to_string(),
                body: "Do it again".to_string(),
                tags: vec![],
            },
        )
        .expect("update")
    }

    #[test]
    fn prompt_ids_are_per_project_and_never_reused() {
        let conn = open_in_memory();
        let first = prompt(&conn, PROJECT, "a");
        let elsewhere = prompt(&conn, "/other", "a");
        assert_eq!((first.id, elsewhere.id), (1, 1));
        assert_eq!(first.tags, vec!["review".to_string()]);

        assert!(delete(&conn, PROJECT, first.id).expect("delete"));
        assert!(!delete(&conn, PROJECT, first.id).expect("delete again"));
        assert_eq!(prompt(&conn, PROJECT, "b").id, 2);
        assert_eq!(get(&conn, "/other", 2).expect("get"), None);
    }

    #[test]
    fn favoriting_leaves_updated_at_and_an_edit_leaves_the_favorite() {
        let conn = open_in_memory();
        let created = prompt(&conn, PROJECT, "a");
        let starred = set_favorite(&conn, PROJECT, created.id, true).expect("favorite");
        assert!(starred.favorite);
        assert_eq!(starred.updated_at, created.updated_at);

        let edited = edit(&conn, created.id, "renamed");
        assert!(edited.favorite);
        assert_eq!(edited.title, "renamed");
        assert!(set_favorite(&conn, PROJECT, 99, true).is_err());
    }

    #[test]
    fn favorites_list_first_then_the_most_recently_edited() {
        let conn = open_in_memory();
        let old = prompt(&conn, PROJECT, "old");
        let starred = prompt(&conn, PROJECT, "starred");
        let new = prompt(&conn, PROJECT, "new");
        set_favorite(&conn, PROJECT, starred.id, true).expect("favorite");
        // Same timestamps fall back to the id, so editing `old` is what moves it ahead of `new`.
        std::thread::sleep(std::time::Duration::from_millis(20));
        edit(&conn, old.id, "old, edited");

        let order: Vec<i32> = list(&conn, PROJECT)
            .expect("list")
            .iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(order, vec![starred.id, old.id, new.id]);
    }

    #[test]
    fn a_prompt_needs_a_title_and_text() {
        let conn = open_in_memory();
        let request = |title: &str, body: &str| CreatePromptRequest {
            project_path: PROJECT.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            tags: vec![],
            favorite: false,
        };
        assert!(create(&conn, &request(" ", "text")).is_err());
        assert!(create(&conn, &request("title", "  ")).is_err());
        assert!(list(&conn, PROJECT).expect("list").is_empty());
    }

    #[test]
    fn only_a_change_owes_a_push() {
        let conn = open_in_memory();
        let (_, pushes) = answer(
            &conn,
            ServerRequest::ListPrompts(ProjectRef {
                project_path: PROJECT.to_string(),
            }),
        )
        .expect("list");
        assert!(pushes.is_empty());
        let (_, pushes) = answer(
            &conn,
            ServerRequest::DeletePrompt(maestro_protocol::PromptRef {
                project_path: PROJECT.to_string(),
                prompt_id: 7,
            }),
        )
        .expect("delete nothing");
        assert!(pushes.is_empty());
    }
}
