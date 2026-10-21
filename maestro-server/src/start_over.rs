//! Start a task over from scratch: the work its agents wrote thrown away, its run state cleared,
//! and the task parked in Planning or Queue.
//!
//! What "the work" is depends on where the task got to. A task still on its branch has that branch
//! rewound: a pipeline task to where it started, a loop to where its first iteration started, so
//! the tests its preparation committed stay. A Done or Cancelled task's branch is left alone, since
//! it is often merged already, and the next run starts a new branch from the base instead.

use std::path::Path;

use maestro_protocol::{
    ApplyTaskTransitionRequest, BranchMode, PhaseStatus, RestartTaskRequest, RunMode,
    ServerRequest, ServerResponse, TaskPhase, TaskStatus, TaskTransition, TransitionGuard,
    WorkspaceMode,
};

use crate::project_store::Store;
use crate::task_store::loops;
use crate::worktree::git;

pub(crate) async fn restart(
    store: &Store,
    request: RestartTaskRequest,
) -> Result<Vec<ServerResponse>, String> {
    let path = crate::automations::canonical_project_path(&request.project_path);
    let task_id = request.task_id;
    if !matches!(request.status, TaskStatus::Planning | TaskStatus::Queue) {
        return Err("A task starts over in Planning or Queue".to_string());
    }
    let (task, row) = {
        let conn = store.lock().await;
        let task = crate::task_store::get(&conn, &path, task_id)?
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        let row = crate::task_store::worktrees::list(&conn, &path, Some(task_id))?
            .into_iter()
            .next();
        (task, row)
    };
    let busy = matches!(
        task.phase_status,
        Some(PhaseStatus::Running | PhaseStatus::Blocked)
    ) || matches!(task.phase, Some(TaskPhase::Spawning | TaskPhase::Checking));
    if busy {
        return Err("Stop the task before starting it over".to_string());
    }
    let looping = task.run_mode == RunMode::Loop;
    let fresh = matches!(task.status, TaskStatus::Done | TaskStatus::Cancelled);
    // A workspace the task borrows is not the task's to rewind.
    let owned = task.workspace_mode == WorkspaceMode::NewWorktree;
    let dir = row
        .as_ref()
        .map(|w| crate::worktree::absolute(&path, &w.path))
        .filter(|dir| owned && Path::new(dir).exists());

    let mut new_branch = None;
    let note = if fresh && owned {
        if let Some(dir) = &dir {
            git(&path, &["worktree", "remove", "--force", dir]).await?;
        }
        if task.workspace_branch_mode == BranchMode::Create {
            let old = row
                .as_ref()
                .map(|w| w.branch_name.clone())
                .or_else(|| {
                    task.workspace_branch
                        .clone()
                        .filter(|b| !b.trim().is_empty())
                })
                .unwrap_or_else(|| crate::worktree::task_branch_name(task_id, &task.title));
            let name = free_branch(&path, &old).await;
            new_branch = Some(name.clone());
            format!(
                "Started over: the next run starts on a new branch, {name}, from {}. {old} is \
                 left as it was.",
                base_name(&task.base_branch)
            )
        } else {
            "Started over: the next run checks its branch out again, and its stages are cleared."
                .to_string()
        }
    } else if let Some(dir) = &dir {
        let start = if looping {
            // Where the loop started is the parent of the first commit an iteration made, else
            // its anchor: the preparation commits its tests before the first iteration, and those
            // stay.
            let first = loops::list_iterations(&*store.lock().await, &path, task_id)?
                .into_iter()
                .find_map(|i| i.commit_sha);
            match first {
                Some(first) => Some(
                    git(dir, &["rev-parse", &format!("{first}^")])
                        .await?
                        .trim()
                        .to_string(),
                ),
                None => task.execution_start_sha.clone(),
            }
        } else {
            task.execution_start_sha.clone()
        };
        match start {
            Some(start) => {
                git(dir, &["reset", "--hard", &start]).await?;
                git(dir, &["clean", "-fd"]).await?;
                format!(
                    "Started over: the branch is back at {}, where the {} started, and its \
                     progress is cleared.",
                    &start[..start.len().min(8)],
                    if looping { "loop" } else { "task" }
                )
            }
            None => "Started over: its progress is cleared.".to_string(),
        }
    } else {
        "Started over: its progress is cleared.".to_string()
    };

    if looping {
        crate::worktree::remove_sandbox(&path, task_id).await?;
    }
    let mut conn = store.lock().await;
    if looping {
        loops::clear_progress(&mut conn, &path, task_id)?;
    }
    crate::task_store::reviews::clear_review(&conn, &path, task_id)?;
    conn.execute(
        "UPDATE tasks SET execution_start_sha = NULL, execute_requested_at = NULL,
                pull_request_url = NULL, pull_request_number = NULL, pull_request_ci = NULL,
                review_rounds = 0, fix_rounds = 0,
                workspace_branch = COALESCE(?3, workspace_branch)
         WHERE project_path = ?1 AND id = ?2",
        rusqlite::params![path, task_id, new_branch],
    )
    .map_err(|e| e.to_string())?;
    let mut pushes = Vec::new();
    if fresh && owned {
        if let Some(row) = &row {
            crate::task_store::worktrees::delete(&mut conn, &path, &[row.id])?;
            pushes.push(ServerResponse::WorktreesChanged(
                maestro_protocol::ProjectRef {
                    project_path: path.clone(),
                },
            ));
        }
    }
    let move_back = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: path.clone(),
        task_id,
        event: TaskTransition::ManualMove(request.status),
        guard: TransitionGuard::Always,
        update: None,
        // A loop starts over as a new one would, with nothing in its thread.
        comment: (!looping).then(|| crate::loop_engine::note_entry(note)),
    });
    let (_, moved) = crate::task_store::requests::answer(&mut conn, move_back)?;
    pushes.extend(moved);
    Ok(pushes)
}

/// `branch`, or the first of `branch-2`, `branch-3`… that does not exist yet.
async fn free_branch(project_path: &str, branch: &str) -> String {
    let taken = |name: String| async move {
        git(
            project_path,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )
        .await
        .is_ok_and(|out| !out.trim().is_empty())
    };
    if !taken(branch.to_string()).await {
        return branch.to_string();
    }
    let mut n = 2;
    while taken(format!("{branch}-{n}")).await {
        n += 1;
    }
    format!("{branch}-{n}")
}

fn base_name(base: &str) -> &str {
    match base.trim() {
        "" => "HEAD",
        base => base,
    }
}
