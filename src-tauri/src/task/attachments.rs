use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::TaskAttachment;
use maestro_protocol::{AddTaskAttachmentRequest, DeleteTaskAttachmentRequest, TaskRef};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

/// Where a task's attachments are copied, relative to the project root. The daemon deletes a
/// copy under here when its row goes; a deleted task's folder is left behind.
const TASK_ATTACHMENTS_DIR: &str = ".maestro/attachments/tasks";

/// Where a task's copy of `name` goes, relative to the project: the name itself, or the first
/// `stem-N.ext` no other attachment of the task holds.
fn attachment_relative_path(task_id: i32, name: &str, taken: &HashSet<&str>) -> String {
    let dir = format!("{TASK_ATTACHMENTS_DIR}/{task_id}");
    let plain = format!("{dir}/{name}");
    if !taken.contains(plain.as_str()) {
        return plain;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (1..)
        .map(|n| format!("{dir}/{stem}-{n}{extension}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .unwrap_or(plain)
}

/// A row's path as an absolute path on the project's machine. Rows written before attachments were
/// copied hold the host path the user picked, which is kept as it is: on any machine but that host
/// it names nothing, and shows as missing.
fn on_project_machine(project_path: &str, file_path: &str) -> String {
    if file_path.starts_with('/') || Path::new(file_path).is_absolute() {
        return file_path.to_string();
    }
    if project_path.contains('\\') {
        format!(
            "{}\\{}",
            project_path.trim_end_matches('\\'),
            file_path.replace('/', "\\")
        )
    } else {
        format!("{}/{}", project_path.trim_end_matches('/'), file_path)
    }
}

fn resolved(attachment: maestro_protocol::TaskAttachment, project_path: &str) -> TaskAttachment {
    let mut attachment: TaskAttachment = attachment.into();
    attachment.file_path = on_project_machine(project_path, &attachment.file_path);
    attachment
}

async fn list_rows(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<maestro_protocol::TaskAttachment>, String> {
    let list = query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskAttachments(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskAttachmentsOk(list) => list),
    )
    .await?;
    Ok(list.attachments)
}

/// Get attachments for a task, each `file_path` absolute on the project's machine.
#[tauri::command]
#[specta::specta]
pub async fn list_task_attachments(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> {
    let (_, project_path) = crate::project::automations::target(&app_state, project_id).await?;
    let rows = list_rows(&app_state, project_id, task_id).await?;
    Ok(rows
        .into_iter()
        .map(|row| resolved(row, &project_path))
        .collect())
}

/// Copy a file the user picked on this machine into the project, on whichever machine the project
/// lives, and record it for the task. Every machine and every agent then reads the same copy.
///
/// A file with the same name and size as one the task already has is taken to be that file, and
/// its row is returned rather than a second copy, which would be sent in every prompt twice.
#[tauri::command]
#[specta::specta]
pub async fn add_task_attachment(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    filename: String,
    file_path: String,
) -> Result<TaskAttachment, String> {
    let (project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let source = Path::new(&file_path);
    let size = tokio::fs::metadata(source)
        .await
        .map_err(|e| format!("Cannot read '{file_path}': {e}"))?
        .len();

    let existing = list_rows(&app_state, project_id, task_id).await?;
    // ponytail: name and size stand in for identity; hash the contents if two differing files of
    // one name and size ever need to be told apart.
    if let Some(same) = existing
        .iter()
        .find(|row| row.filename == filename && u64::try_from(row.file_size) == Ok(size))
    {
        return Ok(resolved(same.clone(), &project.path));
    }

    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("'{file_path}' names no file"))?;
    let taken: HashSet<&str> = existing.iter().map(|row| row.file_path.as_str()).collect();
    let relative = attachment_relative_path(task_id, name, &taken);
    let dir = on_project_machine(&project.path, &format!("{TASK_ATTACHMENTS_DIR}/{task_id}"));
    let dest = on_project_machine(&project.path, &relative);
    crate::acp::attachment_handlers::copy_to_machine(&app_state, &conn, source, &dir, &dest)
        .await?;

    let attachment = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskAttachment(AddTaskAttachmentRequest {
                project_path,
                task_id,
                filename,
                file_path: relative,
            })
        },
        reply!(ServerResponse::AddTaskAttachmentOk(attachment) => attachment),
    )
    .await?;
    Ok(resolved(attachment, &project.path))
}

/// Remove an attachment record by id. The daemon deletes the project's copy with it.
#[tauri::command]
#[specta::specta]
pub async fn delete_task_attachment(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    attachment_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::DeleteTaskAttachment(DeleteTaskAttachmentRequest {
                project_path,
                attachment_id,
            })
        },
        reply!(ServerResponse::DeleteTaskAttachmentOk => ()),
    )
    .await
}

/// The prompt block for each of a task's attachments, in order, or `None` for one whose file is
/// not on the project's machine. A link to the project's copy rather than its contents: the file is
/// already where the agent runs, whatever its working directory, and `resource_link` is the block
/// every ACP agent has to accept.
#[tauri::command]
#[specta::specta]
pub async fn prepare_task_attachments(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    paths: Vec<String>,
) -> Result<Vec<Option<serde_json::Value>>, String> {
    let (_, conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let mut blocks = Vec::with_capacity(paths.len());
    for path in paths {
        // An unreachable machine is an error, not a missing file: the caller offers to delete the
        // rows of missing ones.
        if !crate::connectivity::files::try_exists(&conn, &path).await? {
            blocks.push(None);
            continue;
        }
        let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
        let mut block = serde_json::json!({
            "type": "resource_link",
            "name": name,
            "uri": format!("file://{path}"),
        });
        if let Some(mime) = crate::acp::attachment_handlers::mime_for_extension(&path) {
            block["mimeType"] = mime.into();
        }
        blocks.push(Some(block));
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_lands_under_the_task_and_steps_aside_for_a_taken_name() {
        let mut taken = HashSet::new();
        assert_eq!(
            attachment_relative_path(4, "notes.txt", &taken),
            ".maestro/attachments/tasks/4/notes.txt"
        );

        taken.insert(".maestro/attachments/tasks/4/notes.txt");
        taken.insert(".maestro/attachments/tasks/4/notes-1.txt");
        assert_eq!(
            attachment_relative_path(4, "notes.txt", &taken),
            ".maestro/attachments/tasks/4/notes-2.txt"
        );
        assert_eq!(
            attachment_relative_path(5, "notes.txt", &taken),
            ".maestro/attachments/tasks/5/notes.txt",
            "another task's folder is its own"
        );

        taken.insert(".maestro/attachments/tasks/4/Makefile");
        assert_eq!(
            attachment_relative_path(4, "Makefile", &taken),
            ".maestro/attachments/tasks/4/Makefile-1"
        );
    }

    #[test]
    fn a_relative_row_resolves_against_the_project_in_its_own_separator() {
        let relative = ".maestro/attachments/tasks/4/notes.txt";
        assert_eq!(
            on_project_machine("/home/me/repo/", relative),
            "/home/me/repo/.maestro/attachments/tasks/4/notes.txt"
        );
        assert_eq!(
            on_project_machine(r"C:\repo", relative),
            r"C:\repo\.maestro\attachments\tasks\4\notes.txt"
        );
        assert_eq!(
            on_project_machine("/home/me/repo", "/tmp/picked.txt"),
            "/tmp/picked.txt",
            "a row from before copying keeps the host path it holds"
        );
    }
}
