//! A task stage's first prompt, composed in the daemon so a stage can start with no window open.
//!
//! A port of the prompt assembly in `useExecuteTask` and of `prepare_task_attachments`: the role
//! prompt, the task, the role's protocol line, then what the thread and the review hold for this
//! stage, then the attachments. The texts are the app's, word for word, because the agent reads
//! the same instructions whichever side started it.

use std::collections::BTreeMap;
use std::path::Path;

use maestro_protocol::{AgentRole, Task, TaskPhase};
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::task_store;

/// Tells the agent how to signal that the task is finished. See `COMPLETION_PROTOCOL` in
/// `useExecuteTask.ts` for why it is worded as it is.
const COMPLETION_PROTOCOL: &str = "When the task is complete and needs no further work, end your final message with `<maestro-task-complete/>` — it moves the task to review, so omit it if you are asking a question or reporting a blocker.";

/// The refiner's final message is the proposal, so it is asked for the description and nothing else.
const REFINER_PROTOCOL: &str = "Read whatever you need from the repository, then reply with the improved task description and nothing else — no preamble, no summary of your changes, no code fences around the whole reply. Your reply is what will replace the description if the user accepts it. The task keeps its existing title, so do not restate it as a heading — start with the description itself. Do not modify any files.";

/// The planner's final message is the plan.
const PLANNER_PROTOCOL: &str = "Investigate the repository and reply with an implementation plan in markdown: what to change, in what order, and anything you found that constrains the approach. Do not modify any files — your reply is the plan, and the user decides whether it is implemented.";

/// The verdict line is what `classify_verdict` reads.
const REVIEWER_PROTOCOL: &str = "Review the changes on this branch against the task. Start your reply with a single line reading exactly `APPROVED` or `CHANGES REQUESTED`, then say why — for changes, be specific about what to fix and where, because your reply is what the coder is given. Do not modify any files.";

/// Where a task's attachments are copied, relative to the project root.
#[cfg(test)]
const TASK_ATTACHMENTS_DIR: &str = ".maestro/attachments/tasks";

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const SCALE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

pub struct ComposedPrompt {
    /// ACP content blocks, as `SessionCommand::PromptStructured` takes them.
    pub blocks: Vec<Value>,
    /// One `filename: reason` per attachment left out. An unattended start skips, never asks.
    pub skipped_attachments: Vec<String>,
}

/// What the store holds for the prompt, read under its lock. The attachments are files, read by
/// [`Draft::embed`] once the lock is let go.
pub struct Draft {
    head: Vec<Value>,
    /// `(filename, absolute path)`, in the order they are sent.
    attachments: Vec<(String, String)>,
    tail: Vec<Value>,
}

impl Draft {
    /// The prompt with its attachments read in. Blocking file IO: run it off the runtime.
    pub fn embed(self) -> ComposedPrompt {
        let mut blocks = self.head;
        let mut skipped_attachments = Vec::new();
        for (filename, path) in self.attachments {
            match attachment_block(&path) {
                Ok(block) => blocks.push(block),
                Err(reason) => skipped_attachments.push(format!("{filename}: {reason}")),
            }
        }
        blocks.extend(self.tail);
        ComposedPrompt {
            blocks,
            skipped_attachments,
        }
    }
}

/// `phase` is the task's phase before its claim, which is what says a coder is reworking or fixing
/// CI: the claim itself always leaves `Spawning`.
pub fn compose(
    conn: &Connection,
    project_path: &str,
    task: &Task,
    phase: Option<TaskPhase>,
    role: AgentRole,
    role_prompt: Option<&str>,
    feedback: Option<&str>,
) -> Result<Draft, String> {
    let mut blocks = Vec::new();
    let text = |text: String| json!({ "type": "text", "text": text });

    let prompt_text = match task.description.as_deref() {
        Some(description) if !description.is_empty() => {
            format!("# {}\n\n{description}", task.title)
        }
        _ => format!("# {}", task.title),
    };
    let role_prompt = match role_prompt {
        Some(p) if !p.is_empty() => format!("{p}\n\n---\n"),
        _ => String::new(),
    };
    let protocol = match role {
        AgentRole::Refiner => REFINER_PROTOCOL,
        AgentRole::Planner => PLANNER_PROTOCOL,
        AgentRole::Reviewer => REVIEWER_PROTOCOL,
        AgentRole::Coder => COMPLETION_PROTOCOL,
    };
    blocks.push(text(format!(
        "{role_prompt}{prompt_text}\n\n---\n{protocol}"
    )));

    let latest = |kind: &str| -> Result<Option<String>, String> {
        Ok(
            task_store::latest_of_kind(conn, project_path, task.id, kind)?
                .and_then(|c| c.body)
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty()),
        )
    };

    let feedback = feedback.map(str::trim).filter(|f| !f.is_empty());
    if let (AgentRole::Planner, Some(feedback)) = (role, feedback) {
        if let Some(previous) = latest("plan")? {
            blocks.push(text(format!("## Your previous plan\n\n{previous}")));
        }
        blocks.push(text(format!(
            "## What the user wants changed about it\n\n{feedback}\n\nReply with the revised plan in full — it replaces the one above."
        )));
    }

    if role == AgentRole::Coder {
        if let Some(plan) = latest("plan")? {
            blocks.push(text(format!("## The approved plan\n\n{plan}")));
        }
        if phase == Some(TaskPhase::Rework) {
            if let Some(verdict) = latest("verdict")? {
                blocks.push(text(format!("## Review findings to address\n\n{verdict}")));
            }
        }
        if phase == Some(TaskPhase::AwaitingMerge) {
            if let Some(ci) = latest("ci")? {
                blocks.push(text(format!(
                    "## CI is failing on the open pull request\n\n{ci}\n\nReproduce the failure locally, fix it, and commit. Your commits are pushed to the existing pull request."
                )));
            }
        }
    }

    let attachments = task_store::list_attachments(conn, project_path, task.id)?
        .into_iter()
        .map(|a| {
            let path = on_project_machine(project_path, &a.file_path);
            (a.filename, path)
        })
        .collect();

    let mut tail = Vec::new();

    // Only the coder acts on a review's per-file comments.
    if role == AgentRole::Coder {
        if let Some(review) = task_store::reviews::get_review(conn, project_path, task.id)?
            .filter(|r| r.decision == "RequestChanges")
        {
            let mut feedback_text = String::new();
            // Grouped by file in first-seen order, as the app's `Map` keeps it.
            let mut order: Vec<&str> = Vec::new();
            let mut grouped: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
            for c in &review.comments {
                let list = grouped.entry(&c.file_path).or_insert_with(|| {
                    order.push(&c.file_path);
                    Vec::new()
                });
                list.push(&c.comment);
            }
            for file_path in order {
                feedback_text.push_str(&format!("## `{file_path}`\n"));
                for (i, comment) in grouped[file_path].iter().enumerate() {
                    feedback_text.push_str(&format!("### Feedback #{}\n{comment}\n\n", i + 1));
                }
            }
            if let Some(general) = review.general_feedback.as_deref().filter(|g| !g.is_empty()) {
                feedback_text.push_str(&format!("## General feedback\n{general}\n"));
            }
            if !feedback_text.is_empty() {
                tail.push(text(feedback_text));
            }
        }
    }

    Ok(Draft {
        head: blocks,
        attachments,
        tail,
    })
}

/// A row's path as an absolute path on this machine: relative rows are measured from the project.
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

/// The block the app's `task_attachment_block` makes: an image inline, a PDF linked, text pasted
/// in. `Err` is the reason it is left out.
fn attachment_block(path: &str) -> Result<Value, String> {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Err("Not found in the project".to_string()),
    };
    let uri = format!("file://{path}");
    let mime = mime_for_extension(path);

    if is_image_extension(path) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "Image too large ({} MB, max {} MB)",
                size / 1_048_576,
                MAX_IMAGE_BYTES / 1_048_576
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("Cannot read '{path}': {e}"))?;
        let bytes = scale_image(bytes)?;
        return Ok(json!({
            "type": "image",
            "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes),
            "mimeType": mime.unwrap_or("image/png"),
            "uri": uri,
        }));
    }

    if is_pdf_extension(path) {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let mut block = json!({ "type": "resource_link", "name": name, "uri": uri });
        if let Some(m) = mime {
            block["mimeType"] = m.into();
        }
        block["size"] = size.into();
        return Ok(block);
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read '{path}': {e}"))?;
    let text = String::from_utf8(bytes).map_err(|e| format!("Cannot read '{path}': {e}"))?;
    let mut resource = json!({ "uri": uri, "text": text });
    if let Some(m) = mime {
        resource["mimeType"] = m.into();
    }
    Ok(json!({ "type": "resource", "resource": resource }))
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn mime_for_extension(path: &str) -> Option<&'static str> {
    Some(match extension(path).as_str() {
        "rs" => "text/x-rust",
        "ts" | "tsx" => "text/typescript",
        "js" | "jsx" => "text/javascript",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "rb" => "text/x-ruby",
        "java" => "text/x-java",
        "c" | "h" => "text/x-c",
        "cpp" => "text/x-c++",
        "toml" => "text/x-toml",
        "json" => "application/json",
        "md" => "text/markdown",
        "yaml" | "yml" => "text/yaml",
        "sh" => "text/x-sh",
        "html" => "text/html",
        "css" => "text/css",
        "sql" => "text/x-sql",
        "graphql" => "text/x-graphql",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

fn is_image_extension(path: &str) -> bool {
    matches!(
        extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "tiff" | "bmp" | "ico" | "svg"
    )
}

fn is_pdf_extension(path: &str) -> bool {
    extension(path) == "pdf"
}

/// An image over the threshold scaled down to it, as the app's `prepare_image_bytes` does. The
/// mime type stays the file's, as it does there.
fn scale_image(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let size = bytes.len() as u64;
    if size <= SCALE_THRESHOLD_BYTES {
        return Ok(bytes);
    }
    let ratio = (SCALE_THRESHOLD_BYTES as f64 / size as f64).sqrt();
    if ratio >= 0.9 {
        return Ok(bytes);
    }
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let resized = img.resize(
        (img.width() as f64 * ratio) as u32,
        (img.height() as f64 * ratio) as u32,
        image::imageops::FilterType::Triangle,
    );
    let mut output = Vec::new();
    resized
        .write_to(
            &mut std::io::Cursor::new(&mut output),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        BranchMode, CreateTaskRequest, ReviewCommentInput, SaveTaskReviewRequest, WorkspaceMode,
    };

    fn setup(project: &str, description: Option<&str>) -> (Connection, Task) {
        let mut conn = crate::project_store::open_in_memory();
        let task = task_store::create(
            &mut conn,
            &CreateTaskRequest {
                project_path: project.to_string(),
                title: "Fix login".to_string(),
                description: description.map(str::to_string),
                skills: vec![],
                labels: vec![],
                base_branch: "main".to_string(),
                agent_id: None,
                priority: None,
                auto_approve: false,
                workspace_mode: WorkspaceMode::NewWorktree,
                workspace_worktree_id: None,
                workspace_branch_mode: BranchMode::Create,
                workspace_branch: None,
                model_override: None,
            },
        )
        .expect("create");
        (conn, task)
    }

    fn note(conn: &Connection, task: &Task, kind: &str, body: &str) {
        task_store::append(
            conn,
            &task.project_path,
            task.id,
            kind,
            "agent",
            Some(body),
            None,
            None,
        )
        .expect("append");
    }

    fn texts(prompt: &ComposedPrompt) -> Vec<&str> {
        prompt
            .blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect()
    }

    const P: &str = "/srv/shop";

    #[test]
    fn a_fresh_coder_gets_the_role_prompt_the_task_and_the_completion_line() {
        let (conn, task) = setup(P, Some("The button is dead."));
        let prompt = compose(
            &conn,
            P,
            &task,
            None,
            AgentRole::Coder,
            Some("Be careful."),
            None,
        )
        .unwrap()
        .embed();
        assert_eq!(
            texts(&prompt),
            vec![format!(
                "Be careful.\n\n---\n# Fix login\n\nThe button is dead.\n\n---\n{COMPLETION_PROTOCOL}"
            )]
        );

        let bare = compose(
            &conn,
            P,
            &Task {
                description: None,
                ..task
            },
            None,
            AgentRole::Coder,
            Some(""),
            None,
        )
        .unwrap()
        .embed();
        assert_eq!(
            texts(&bare),
            vec![format!("# Fix login\n\n---\n{COMPLETION_PROTOCOL}")]
        );
    }

    #[test]
    fn a_coder_in_rework_gets_the_plan_the_findings_and_the_review_comments() {
        let (mut conn, task) = setup(P, None);
        note(&conn, &task, "plan", "old plan");
        note(&conn, &task, "plan", "  1. do it  ");
        note(&conn, &task, "verdict", "CHANGES REQUESTED\nmissing test");
        note(&conn, &task, "ci", "lint failed");
        task_store::reviews::save_review(
            &mut conn,
            &SaveTaskReviewRequest {
                project_path: P.to_string(),
                task_id: task.id,
                decision: "RequestChanges".to_string(),
                general_feedback: Some("Tidy up.".to_string()),
                comments: Some(vec![
                    ReviewCommentInput {
                        file_path: "b.rs".into(),
                        comment: "one".into(),
                    },
                    ReviewCommentInput {
                        file_path: "a.rs".into(),
                        comment: "two".into(),
                    },
                    ReviewCommentInput {
                        file_path: "b.rs".into(),
                        comment: "three".into(),
                    },
                ]),
            },
        )
        .unwrap();
        let rework = Some(TaskPhase::Rework);

        let prompt = compose(&conn, P, &task, rework, AgentRole::Coder, None, None)
            .unwrap()
            .embed();
        let t = texts(&prompt);
        assert_eq!(t.len(), 4);
        assert_eq!(t[1], "## The approved plan\n\n1. do it");
        assert_eq!(
            t[2],
            "## Review findings to address\n\nCHANGES REQUESTED\nmissing test"
        );
        assert_eq!(
            t[3],
            "## `b.rs`\n### Feedback #1\none\n\n### Feedback #2\nthree\n\n## `a.rs`\n### Feedback #1\ntwo\n\n## General feedback\nTidy up.\n"
        );

        // The reviewer reads none of it.
        let reviewer = compose(&conn, P, &task, rework, AgentRole::Reviewer, None, None)
            .unwrap()
            .embed();
        assert_eq!(
            texts(&reviewer),
            vec![format!("# Fix login\n\n---\n{REVIEWER_PROTOCOL}")]
        );
    }

    #[test]
    fn a_coder_awaiting_merge_gets_the_ci_report() {
        let (conn, task) = setup(P, None);
        note(&conn, &task, "verdict", "ignored outside rework");
        note(&conn, &task, "ci", "build failed: test_login");
        let phase = Some(TaskPhase::AwaitingMerge);
        let prompt = compose(&conn, P, &task, phase, AgentRole::Coder, None, None)
            .unwrap()
            .embed();
        assert_eq!(
            texts(&prompt)[1..],
            ["## CI is failing on the open pull request\n\nbuild failed: test_login\n\nReproduce the failure locally, fix it, and commit. Your commits are pushed to the existing pull request."]
        );
    }

    #[test]
    fn a_planner_with_feedback_sees_its_last_plan_and_without_it_starts_over() {
        let (conn, task) = setup(P, None);
        note(&conn, &task, "plan", "the plan");
        let prompt = compose(
            &conn,
            P,
            &task,
            None,
            AgentRole::Planner,
            None,
            Some(" smaller "),
        )
        .unwrap()
        .embed();
        assert_eq!(
            texts(&prompt),
            vec![
                format!("# Fix login\n\n---\n{PLANNER_PROTOCOL}"),
                "## Your previous plan\n\nthe plan".to_string(),
                "## What the user wants changed about it\n\nsmaller\n\nReply with the revised plan in full — it replaces the one above.".to_string(),
            ]
        );
        let fresh = compose(&conn, P, &task, None, AgentRole::Planner, None, Some("  "))
            .unwrap()
            .embed();
        assert_eq!(texts(&fresh).len(), 1);
        let refiner = compose(&conn, P, &task, None, AgentRole::Refiner, None, None)
            .unwrap()
            .embed();
        assert_eq!(
            texts(&refiner),
            vec![format!("# Fix login\n\n---\n{REFINER_PROTOCOL}")]
        );
    }

    /// Ported from `useExecuteTask.test.tsx`: a file that is gone or too big is skipped with a
    /// reason and the rest are sent; no row is deleted.
    #[test]
    fn attachments_are_embedded_and_the_unusable_ones_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_str().unwrap().to_string();
        let (conn, task) = setup(&project, None);
        let folder = dir
            .path()
            .join(TASK_ATTACHMENTS_DIR)
            .join(task.id.to_string());
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("notes.md"), "hello").unwrap();
        std::fs::write(folder.join("shot.png"), [1u8, 2, 3, 4]).unwrap();
        std::fs::write(folder.join("spec.pdf"), [0u8; 7]).unwrap();
        std::fs::write(folder.join("huge.png"), vec![0u8; 11 * 1024 * 1024]).unwrap();
        let rel = |name: &str| format!("{TASK_ATTACHMENTS_DIR}/{}/{name}", task.id);
        for name in ["notes.md", "gone.txt", "shot.png", "spec.pdf", "huge.png"] {
            task_store::add_attachment(&conn, &project, task.id, name, &rel(name)).unwrap();
        }

        let prompt = compose(
            &conn,
            &project,
            &task,
            None,
            AgentRole::Reviewer,
            None,
            None,
        )
        .unwrap()
        .embed();
        let blocks = &prompt.blocks[1..];
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "resource");
        assert_eq!(blocks[0]["resource"]["text"], "hello");
        assert_eq!(blocks[0]["resource"]["mimeType"], "text/markdown");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["data"], "AQIDBA==");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert_eq!(blocks[2]["type"], "resource_link");
        assert_eq!(blocks[2]["name"], "spec.pdf");
        assert_eq!(blocks[2]["size"], 7);
        assert_eq!(
            prompt.skipped_attachments,
            vec![
                "gone.txt: Not found in the project".to_string(),
                "huge.png: Image too large (11 MB, max 10 MB)".to_string(),
            ]
        );
        assert_eq!(
            task_store::list_attachments(&conn, &project, task.id)
                .unwrap()
                .len(),
            5
        );
    }
}
