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

/// A loop's worker: one iteration of many, judged by checks it cannot see.
const LOOP_PROTOCOL: &str = "You are one iteration of a loop that runs until this task's checks pass. Each iteration is a fresh session, so nothing you say carries over, only what you leave on disk. Start by reading `.maestro/loop/PROGRESS.md` if it exists, and before you stop, update it with what you did, what you learned and what is left, for the next iteration. Make real progress toward the goal, then end your turn: your changes are committed and the checks run after you stop. The checks' sources are not available to you and their failures reach you as output only, so do not look for them or try to change them. Do not declare the task done; the checks decide. Maestro's `loop_status` tool says where the loop stands. If the goal needs a check the list lacks, propose it with `loop_propose_check`. If you cannot go on without the user, call `loop_blocked` with what you need from them, then end your turn.";

/// A loop's preparer, in place of the refiner: sets the loop up with the user before it runs.
const PREPARE_PROTOCOL: &str = "You are preparing this loop with the user before it runs. Once queued, the loop gives the goal above to a worker agent, in fresh sessions, until every check passes. The worker works in a copy of this branch without the sealed paths, so it never sees or changes the tests that judge it. You work in the loop's own worktree, where those tests belong. Talk it through with the user: what done means, and how a command can prove it. Write the tests or check scripts the loop needs and commit them here: a path has to be committed before it can be sealed. Then set the loop with Maestro's `update_task` tool: `checks` (Command, Judge or Manual, replacing the list, with a Setup step first for anything the checks need done before they run, such as installing dependencies), `sealed_paths` for what the worker must not see or change, including the files a check depends on such as the test config or the package.json that defines its script, and the budgets. Do not implement the goal itself: that is the worker's job, and the checks should fail until it is done. End each turn with a short summary of the loop as it now stands.";

/// A loop's judge: decides the `judge` checks against the loop's work, then writes the digest.
const JUDGE_PROTOCOL: &str = "You are the judge of a loop: another agent has worked on this task in iterations, and its work is committed on this branch. Decide each check listed below against that work, reading the diff and the code it touches. Do not modify any files, and do not run the project's tests; they are checked separately. Answer every check on a line of its own, by its number, starting with PASS or FAIL and one line of reason, for example:\n\n1. PASS: unknown ids answer 404\n2. FAIL: nothing handles an empty list\n\nA FAIL's reason is all the next iteration is told, so make it specific. If every check passes, follow the verdicts with a line reading `## Digest` and a short review for the person who signs the work off, in three parts: `### What changed`, `### What the loop decided on its own` and `### Worth a look`.";

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

fn protocol(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Refiner => REFINER_PROTOCOL,
        AgentRole::Planner => PLANNER_PROTOCOL,
        AgentRole::Reviewer => REVIEWER_PROTOCOL,
        AgentRole::Coder => COMPLETION_PROTOCOL,
        AgentRole::Preparer => PREPARE_PROTOCOL,
        AgentRole::Judge => JUDGE_PROTOCOL,
        AgentRole::Worker => LOOP_PROTOCOL,
    }
}

/// A stage's standing orders: the profile's role prompt, then the role's protocol line.
///
/// Sent as the session's system prompt where the agent takes one, so compaction cannot summarise
/// them away and a reload brings them back. Elsewhere [`compose`] puts them around the task.
pub fn instructions(role: AgentRole, role_prompt: Option<&str>) -> String {
    match role_prompt.filter(|p| !p.is_empty()) {
        Some(role_prompt) => format!("{role_prompt}\n\n---\n{}", protocol(role)),
        None => protocol(role).to_string(),
    }
}

/// [`instructions`] for a task session being reloaded, rebuilt from its row's `role` meta
/// (`{"role": "Coder", "profile_id": ...}`). `None` for a session that is not a task stage.
pub fn session_instructions(project_path: &str, role_meta: Option<&str>) -> Option<String> {
    let meta: Value = serde_json::from_str(role_meta?).ok()?;
    let role = serde_json::from_value(meta.get("role")?.clone()).ok()?;
    let profile_id = meta.get("profile_id").and_then(Value::as_str);
    let role_prompt = crate::profiles::role_prompt(project_path, role, profile_id);
    Some(instructions(role, role_prompt.as_deref()))
}

/// `phase` is the task's phase before its claim, which is what says a coder is reworking or fixing
/// CI: the claim itself always leaves `Spawning`. `inline` is false when the session already has
/// the role prompt and protocol line as its system prompt.
#[allow(clippy::too_many_arguments)]
pub fn compose(
    conn: &Connection,
    project_path: &str,
    task: &Task,
    phase: Option<TaskPhase>,
    role: AgentRole,
    role_prompt: Option<&str>,
    inline: bool,
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
    let looping = role == AgentRole::Worker;
    let preparing = role == AgentRole::Preparer;
    if inline {
        let role_prompt = match role_prompt {
            Some(p) if !p.is_empty() => format!("{p}\n\n---\n"),
            _ => String::new(),
        };
        blocks.push(text(format!(
            "{role_prompt}{prompt_text}\n\n---\n{}",
            protocol(role)
        )));
    } else {
        blocks.push(text(prompt_text));
    }

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

    if looping {
        blocks.push(text(loop_context(conn, project_path, task)?));
        if phase == Some(TaskPhase::AwaitingMerge) {
            if let Some(ci) = latest("ci")? {
                blocks.push(text(format!(
                    "## CI is failing on the open pull request\n\n{ci}\n\nReproduce the failure locally, fix it, and commit. Once the checks pass and the user signs off, your commits are pushed to the existing pull request."
                )));
            }
        }
    } else if preparing {
        blocks.push(text(prepare_context(conn, project_path, task)?));
    } else if role == AgentRole::Judge {
        // The judge's `feedback` is the diff's stat, which the starter read from the worktree.
        blocks.push(text(judge_context(conn, project_path, task, feedback)?));
    } else if role == AgentRole::Coder {
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

    // A review's comments are for whoever writes the code: the coder, or a loop sent back from its
    // sign-off or by a merge conflict.
    if looping || role == AgentRole::Coder {
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

/// The loop as it is set up so far, for its preparer.
fn prepare_context(conn: &Connection, project_path: &str, task: &Task) -> Result<String, String> {
    let config = task.loop_config.clone().unwrap_or_default();
    let checks = task_store::loops::list_checks(conn, project_path, task.id)?;
    let mut out = String::from(
        "## The loop as it stands

",
    );
    if checks.is_empty() {
        out.push_str("No checks yet.");
    } else {
        out.push_str("Checks:");
        for check in &checks {
            out.push_str(&format!(
                "
- {:?}: {}",
                check.kind, check.label
            ));
            if let Some(command) = check.command.as_deref() {
                out.push_str(&format!(" (`{command}`)"));
            }
            if let Some(secs) = check.timeout_secs {
                out.push_str(&format!(", time limit {} minutes", secs.div_ceil(60)));
            }
        }
    }
    if config.sealed_paths.is_empty() {
        out.push_str(
            "

Nothing is sealed yet.",
        );
    } else {
        out.push_str(
            "

Sealed: ",
        );
        let paths: Vec<String> = config
            .sealed_paths
            .iter()
            .map(|p| format!("`{p}`"))
            .collect();
        out.push_str(&paths.join(", "));
    }
    out.push_str(&format!(
        "

Budget: {} iterations, each Build closed after {} minutes, stopping after {} in a row with no progress. A step or check without its own limit may run for {} minutes.",
        config.max_iterations,
        config.max_build_secs / 60,
        config.stall_limit,
        config.check_timeout_secs / 60
    ));
    Ok(out)
}

/// Where the loop stands: the iteration and budget, every check, and what the failing ones said.
fn loop_context(conn: &Connection, project_path: &str, task: &Task) -> Result<String, String> {
    use maestro_protocol::{LoopCheckKind, LoopCheckState, LoopIterationOutcome};
    use task_store::loops;

    let config = task.loop_config.clone().unwrap_or_default();
    let n = loops::next_iteration(conn, project_path, task.id)?;
    let iterations = loops::list_iterations(conn, project_path, task.id)?;
    let mut out = format!(
        "## Iteration {n}\n\nThis is iteration {n} of at most {}.",
        config.max_iterations
    );

    let checks: Vec<_> = loops::list_checks(conn, project_path, task.id)?
        .into_iter()
        .filter(|c| !c.proposed || c.accepted)
        .collect();
    if !checks.is_empty() {
        out.push_str("\n\n## Checks\n");
        for check in &checks {
            let how = match (check.kind, check.state) {
                (LoopCheckKind::Command, LoopCheckState::Pass) => "passing",
                (LoopCheckKind::Command, LoopCheckState::Fail) => "failing",
                (LoopCheckKind::Command, LoopCheckState::Flaky) => "flaky",
                (LoopCheckKind::Command, LoopCheckState::Pending) => "not run yet",
                (LoopCheckKind::Judge, LoopCheckState::Fail) => "the judge failed it",
                (LoopCheckKind::Judge, _) => "judged against your diff once the others pass",
                (LoopCheckKind::Manual, _) => "checked by the user at the end",
                (LoopCheckKind::Setup, LoopCheckState::Fail) => {
                    "a step run before the checks; it failed, so no check ran"
                }
                (LoopCheckKind::Setup, _) => "a step run before the checks",
            };
            out.push_str(&format!("\n- {} ({how})", check.label));
        }
        for check in checks
            .iter()
            .filter(|c| matches!(c.state, LoopCheckState::Fail | LoopCheckState::Flaky))
        {
            let Some(detail) = check.detail.as_deref().filter(|d| !d.trim().is_empty()) else {
                continue;
            };
            match check.kind {
                LoopCheckKind::Command | LoopCheckKind::Setup => out.push_str(&format!(
                    "\n\n### Output of \"{}\"\n\n```\n{}\n```",
                    check.label,
                    detail.trim_end()
                )),
                LoopCheckKind::Judge => out.push_str(&format!(
                    "\n\n### The judge on \"{}\"\n\n{}",
                    check.label,
                    detail.trim()
                )),
                LoopCheckKind::Manual => {}
            }
        }
    }

    let last = iterations
        .iter()
        .rev()
        .find(|i| i.outcome != LoopIterationOutcome::Running);
    // The previous iteration's commit, when a hook refused it.
    if let Some(last) = last {
        if let (LoopIterationOutcome::Failed, Some(output)) = (last.outcome, &last.check_output) {
            out.push_str(&format!(
                "\n\n## The last iteration ended with an error\n\n```\n{}\n```",
                output.trim_end()
            ));
        }
    }

    // What the user's answer below is about.
    if let Some(reason) = last
        .filter(|last| last.outcome == LoopIterationOutcome::Blocked)
        .and_then(|last| last.blocked.as_deref())
    {
        out.push_str(&format!(
            "

## The last iteration was blocked

It asked the user:

{}",
            reason.trim()
        ));
    }

    // What the user said since the previous iteration began.
    let notes: Vec<String> = task_store::list_comments(conn, project_path, task.id)?
        .into_iter()
        .filter(|c| c.kind == "steer")
        .filter(|c| last.is_none_or(|last| c.created_at > last.started_at))
        .filter_map(|c| c.body)
        .map(|body| body.trim().to_string())
        .filter(|body| !body.is_empty())
        .collect();
    if !notes.is_empty() {
        out.push_str("\n\n## Notes from the user\n\n");
        out.push_str(&notes.join("\n\n"));
    }
    Ok(out)
}

/// What the judge decides: the loop's work against its base, and the checks to answer by number.
fn judge_context(
    conn: &Connection,
    project_path: &str,
    task: &Task,
    stat: Option<&str>,
) -> Result<String, String> {
    let base = match task.base_branch.trim() {
        "" => task.execution_start_sha.as_deref().unwrap_or("HEAD"),
        base => base,
    };
    let mut out = format!("## The work\n\nThe loop's changes are `git diff {base}...HEAD`.");
    if let Some(stat) = stat.map(str::trim_end).filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("\n\n```\n{stat}\n```"));
    }
    out.push_str("\n\n## Checks to decide\n");
    let (checks, _) = task_store::loops::to_judge(conn, project_path, task.id)?;
    for (i, check) in checks.iter().enumerate() {
        out.push_str(&format!("\n{}. {}", i + 1, check.label));
    }
    Ok(out)
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
                run_mode: maestro_protocol::RunMode::Pipeline,
                loop_config: None,
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
            true,
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
            true,
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
    fn a_session_with_a_system_prompt_gets_only_the_task() {
        let (conn, task) = setup(P, Some("The button is dead."));
        let prompt = compose(
            &conn,
            P,
            &task,
            None,
            AgentRole::Coder,
            Some("Be careful."),
            false,
            None,
        )
        .unwrap()
        .embed();
        assert_eq!(
            texts(&prompt),
            vec![
                "# Fix login

The button is dead."
            ]
        );
        assert_eq!(
            instructions(AgentRole::Coder, Some("Be careful.")),
            format!(
                "Be careful.

---
{COMPLETION_PROTOCOL}"
            )
        );
        assert_eq!(
            instructions(AgentRole::Reviewer, Some("")),
            REVIEWER_PROTOCOL
        );
    }

    #[test]
    fn a_reloaded_stage_gets_its_profiles_instructions_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".maestro")).unwrap();
        std::fs::write(
            dir.path().join(".maestro/profiles.json"),
            r#"{"profiles":[{"id":"strict","name":"Strict","role":"Reviewer","agent_id":"a","role_prompt":"Be strict."}]}"#,
        )
        .unwrap();
        let project = dir.path().to_str().unwrap();

        assert_eq!(
            session_instructions(
                project,
                Some(r#"{"role":"Reviewer","profile_id":"strict"}"#)
            ),
            Some(format!(
                "Be strict.

---
{REVIEWER_PROTOCOL}"
            ))
        );
        assert_eq!(
            session_instructions(P, Some(r#"{"role":"Coder","profile_id":null}"#)),
            Some(COMPLETION_PROTOCOL.to_string())
        );
        assert_eq!(session_instructions(project, None), None);
        assert_eq!(session_instructions(project, Some("not json")), None);
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

        let prompt = compose(&conn, P, &task, rework, AgentRole::Coder, None, true, None)
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
        let reviewer = compose(
            &conn,
            P,
            &task,
            rework,
            AgentRole::Reviewer,
            None,
            true,
            None,
        )
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
        let prompt = compose(&conn, P, &task, phase, AgentRole::Coder, None, true, None)
            .unwrap()
            .embed();
        assert_eq!(
            texts(&prompt)[1..],
            ["## CI is failing on the open pull request\n\nbuild failed: test_login\n\nReproduce the failure locally, fix it, and commit. Your commits are pushed to the existing pull request."]
        );
    }

    #[test]
    fn a_loops_worker_gets_the_ci_report_and_a_merge_conflicts_feedback() {
        let (mut conn, task) = setup(P, None);
        note(&conn, &task, "ci", "build failed: test_login");
        let phase = Some(TaskPhase::AwaitingMerge);
        let prompt = compose(&conn, P, &task, phase, AgentRole::Worker, None, true, None)
            .unwrap()
            .embed();
        assert!(
            texts(&prompt).iter().any(|t| t.starts_with(
                "## CI is failing on the open pull request\n\nbuild failed: test_login"
            )),
            "{:?}",
            texts(&prompt)
        );

        task_store::reviews::save_review(
            &mut conn,
            &SaveTaskReviewRequest {
                project_path: P.to_string(),
                task_id: task.id,
                decision: "RequestChanges".to_string(),
                general_feedback: Some("Merge conflict in a.rs".to_string()),
                comments: None,
            },
        )
        .unwrap();
        let rework = Some(TaskPhase::Rework);
        let prompt = compose(&conn, P, &task, rework, AgentRole::Worker, None, true, None)
            .unwrap()
            .embed();
        let t = texts(&prompt);
        assert_eq!(
            t.last(),
            Some(&"## General feedback\nMerge conflict in a.rs\n")
        );
        assert!(!t.iter().any(|t| t.contains("CI is failing")), "{t:?}");
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
            true,
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
        let fresh = compose(
            &conn,
            P,
            &task,
            None,
            AgentRole::Planner,
            None,
            true,
            Some("  "),
        )
        .unwrap()
        .embed();
        assert_eq!(texts(&fresh).len(), 1);
        let refiner = compose(&conn, P, &task, None, AgentRole::Refiner, None, true, None)
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
            true,
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
