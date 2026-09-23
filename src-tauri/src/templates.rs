//! Templates: reusable starting points, saved from something that already exists.
//!
//! App-wide rather than per project or per host, so a template saved on one project is there on
//! every other, whatever connection it is on. Automations are the only kind today; the body is
//! tagged by kind so that skills, MCP servers or prompts are a new variant of `TemplateBody`, not
//! a new table.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::core::AppState;
use crate::project::automations::WebhookOverlap;

/// What an automation template keeps: what to do and what starts it.
///
/// Agent, model and workspace are left out on purpose. They belong to a project, and are taken
/// from the project a template is used in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AutomationTemplate {
    pub prompt: String,
    #[specta(optional)]
    pub cron: Option<String>,
    pub timezone: String,
    pub webhook_enabled: bool,
    pub webhook_overlap: WebhookOverlap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TemplateBody {
    Automation(AutomationTemplate),
}

impl TemplateBody {
    fn kind(&self) -> &'static str {
        match self {
            TemplateBody::Automation(_) => "automation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Template {
    pub id: i32,
    pub name: String,
    /// A topic the user files it under, shown on its card and searched.
    #[specta(optional)]
    pub tag: Option<String>,
    pub body: TemplateBody,
    pub created_at: String,
}

fn read(conn: &Connection, id: i32) -> Result<Option<Template>, String> {
    conn.query_row(
        "SELECT id, name, tag, body, created_at FROM templates WHERE id = ?",
        [id],
        |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("Failed to read template: {}", e))?
    .map(|(id, name, tag, body, created_at)| {
        Ok(Template {
            id,
            name,
            tag,
            body: serde_json::from_str(&body).map_err(|e| format!("Unreadable template: {}", e))?,
            created_at,
        })
    })
    .transpose()
}

/// Every template, newest first. One whose body this build cannot read (a kind from a newer
/// build) is skipped rather than failing the list.
pub fn list(conn: &Connection) -> Result<Vec<Template>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, tag, body, created_at FROM templates ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| format!("Failed to list templates: {}", e))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("Failed to list templates: {}", e))?;
    let mut templates = Vec::new();
    for row in rows {
        let (id, name, tag, body, created_at) =
            row.map_err(|e| format!("Failed to list templates: {}", e))?;
        match serde_json::from_str(&body) {
            Ok(body) => templates.push(Template {
                id,
                name,
                tag,
                body,
                created_at,
            }),
            Err(e) => log::warn!("Skipping template {} with an unreadable body: {}", id, e),
        }
    }
    Ok(templates)
}

/// Insert when `id` is `None`, replace otherwise. The kind of an existing template is whatever the
/// new body says; the editor never offers to change it.
pub fn save(
    conn: &Connection,
    id: Option<i32>,
    name: &str,
    tag: Option<&str>,
    body: &TemplateBody,
) -> Result<Template, String> {
    let name = name.trim();
    let tag = tag.map(str::trim).filter(|tag| !tag.is_empty());
    if name.is_empty() {
        return Err("A template needs a name".into());
    }
    let json = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let id = match id {
        Some(id) => {
            let changed = conn
                .execute(
                    "UPDATE templates SET kind = ?1, name = ?2, tag = ?3, body = ?4 WHERE id = ?5",
                    params![body.kind(), name, tag, json, id],
                )
                .map_err(|e| format!("Failed to save template: {}", e))?;
            if changed == 0 {
                return Err("That template no longer exists".into());
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO templates (kind, name, tag, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![body.kind(), name, tag, json, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|e| format!("Failed to save template: {}", e))?;
            conn.last_insert_rowid() as i32
        }
    };
    read(conn, id)?.ok_or_else(|| "Template vanished while saving".into())
}

fn db(app_state: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn list_templates(app_state: State<Arc<AppState>>) -> Result<Vec<Template>, String> {
    list(&*db(&app_state)?)
}

/// Create a template, or replace the one `id` names.
#[tauri::command]
#[specta::specta]
pub fn save_template(
    app_state: State<Arc<AppState>>,
    id: Option<i32>,
    name: String,
    tag: Option<String>,
    body: TemplateBody,
) -> Result<Template, String> {
    save(&*db(&app_state)?, id, &name, tag.as_deref(), &body)
}

#[tauri::command]
#[specta::specta]
pub fn delete_template(app_state: State<Arc<AppState>>, id: i32) -> Result<(), String> {
    db(&app_state)?
        .execute("DELETE FROM templates WHERE id = ?", [id])
        .map_err(|e| format!("Failed to delete template: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(prompt: &str) -> TemplateBody {
        TemplateBody::Automation(AutomationTemplate {
            prompt: prompt.into(),
            cron: Some("0 9 * * *".into()),
            timezone: "Europe/Paris".into(),
            webhook_enabled: false,
            webhook_overlap: WebhookOverlap::Refuse,
        })
    }

    #[test]
    fn saves_updates_and_lists_newest_first() {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();

        let first = save(&conn, None, " Lint ", Some(" Quality "), &body("lint it")).unwrap();
        assert_eq!(first.name, "Lint");
        assert_eq!(first.tag.as_deref(), Some("Quality"));
        let second = save(&conn, None, "Docs", Some("  "), &body("write docs")).unwrap();
        assert_eq!(second.tag, None);

        let edited = save(
            &conn,
            Some(first.id),
            "Lint all",
            None,
            &body("lint all of it"),
        )
        .unwrap();
        assert_eq!(edited.body, body("lint all of it"));
        assert_eq!(edited.created_at, first.created_at);
        assert_eq!(edited.tag, None);

        let names: Vec<_> = list(&conn).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(names, vec![second.id, first.id]);

        assert!(save(&conn, None, "  ", None, &body("x")).is_err());
        assert!(save(&conn, Some(999), "Gone", None, &body("x")).is_err());
    }

    #[test]
    fn an_unreadable_body_is_skipped() {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::initialize_schema(&conn).unwrap();
        save(&conn, None, "Good", None, &body("ok")).unwrap();
        conn.execute(
            "INSERT INTO templates (kind, name, body, created_at) VALUES ('skill', 'Future', '{\"kind\":\"skill\"}', '2026-01-01')",
            [],
        )
        .unwrap();
        let names: Vec<_> = list(&conn).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["Good"]);
    }
}
