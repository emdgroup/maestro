//! The task, worktree and review requests, answered against the store, with what each change owes
//! every attached window.
//!
//! Every path is canonicalized first, so two spellings of one project cannot split its board or its
//! id counter, and replies and pushes carry the canonical one. A write that changed nothing, such as
//! a transition its guard refused, owes no push.

use maestro_protocol::{
    OptionalTask, OptionalTaskReview, OptionalWorktree, ProjectRef, RequestTaskExecutionResponse,
    SaveTaskReviewResponse, ServerRequest, ServerResponse, TaskAttachmentList, TaskCommentList,
    TaskIdList, TaskInstructionList, TaskList, TaskRef, TaskRelationshipList, WorktreeList,
};
use rusqlite::Connection;

use super::{reviews, transition, worktrees};
use crate::automations::canonical_project_path;

/// What a change to the rows of one project owes: which of the three pushes to send.
#[derive(Default)]
struct Changed {
    tasks: bool,
    worktrees: bool,
    comments_of: Option<i32>,
}

/// The reply to `request`, and the pushes to broadcast after it.
pub fn answer(
    conn: &mut Connection,
    request: ServerRequest,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    use ServerRequest as Q;
    use ServerResponse as A;

    let tasks = Changed {
        tasks: true,
        ..Changed::default()
    };
    let thread = |task_id| Changed {
        comments_of: Some(task_id),
        ..Changed::default()
    };
    let worktree_rows = Changed {
        worktrees: true,
        ..Changed::default()
    };
    let canonical = |path: &mut String| *path = canonical_project_path(path);

    let (project_path, reply, changed) = match request {
        Q::ListTasks(mut r) => {
            canonical(&mut r.project_path);
            let tasks = super::list(conn, &r.project_path)?;
            (
                r.project_path,
                A::ListTasksOk(TaskList { tasks }),
                Changed::default(),
            )
        }
        Q::GetTask(mut r) => {
            canonical(&mut r.project_path);
            let task = super::get(conn, &r.project_path, r.task_id)?;
            (
                r.project_path,
                A::GetTaskOk(OptionalTask { task }),
                Changed::default(),
            )
        }
        Q::CreateTask(mut r) => {
            canonical(&mut r.project_path);
            let task = super::create(conn, &r)?;
            (r.project_path, A::CreateTaskOk(task), tasks)
        }
        Q::UpdateTask(mut r) => {
            canonical(&mut r.project_path);
            let task = super::update(conn, &r.project_path, r.task_id, &r.update)?;
            (r.project_path, A::UpdateTaskOk(task), tasks)
        }
        Q::ArchiveTask(mut r) => {
            canonical(&mut r.project_path);
            let task = super::archive(conn, &r.project_path, r.task_id)?;
            (r.project_path, A::ArchiveTaskOk(task), tasks)
        }
        Q::CancelTask(mut r) => {
            canonical(&mut r.project_path);
            let task = super::cancel(conn, &r.project_path, r.task_id)?;
            (r.project_path, A::CancelTaskOk(task), tasks)
        }
        Q::DeleteTask(mut r) => {
            canonical(&mut r.project_path);
            super::delete(conn, &r.project_path, r.task_id)?;
            // The thread goes by cascade, and a worktree the task owned is released by trigger.
            let changed = Changed {
                tasks: true,
                worktrees: true,
                comments_of: Some(r.task_id),
            };
            (r.project_path, A::DeleteTaskOk, changed)
        }
        Q::ApplyTaskTransition(mut r) => {
            canonical(&mut r.project_path);
            let task = transition::apply_transition(conn, &r)?;
            let changed = Changed {
                tasks: task.is_some(),
                comments_of: r.comment.as_ref().and(task.as_ref()).map(|_| r.task_id),
                ..Changed::default()
            };
            (
                r.project_path,
                A::ApplyTaskTransitionOk(OptionalTask { task }),
                changed,
            )
        }
        Q::EndTaskTurn(mut r) => {
            canonical(&mut r.project_path);
            let task = super::end_turn(conn, &r)?;
            let changed = Changed {
                tasks: task.is_some(),
                comments_of: task.as_ref().map(|_| r.task_id),
                ..Changed::default()
            };
            (
                r.project_path,
                A::EndTaskTurnOk(OptionalTask { task }),
                changed,
            )
        }
        Q::CloseRefinement(mut r) => {
            canonical(&mut r.project_path);
            let task = super::close_refinement(conn, &r)?;
            // Accepting takes the proposal out of the thread.
            let changed = Changed {
                tasks: true,
                comments_of: r.accept.then_some(r.task_id),
                ..Changed::default()
            };
            (r.project_path, A::CloseRefinementOk(task), changed)
        }
        Q::RequestTaskExecution(mut r) => {
            canonical(&mut r.project_path);
            let deferred = super::request_execution(conn, &r)?;
            let changed = Changed {
                tasks: deferred,
                ..Changed::default()
            };
            let reply = A::RequestTaskExecutionOk(RequestTaskExecutionResponse { deferred });
            (r.project_path, reply, changed)
        }
        Q::ListQueueCandidates(mut r) => {
            canonical(&mut r.project_path);
            let task_ids = super::queue_candidates(conn, &r)?;
            (
                r.project_path,
                A::ListQueueCandidatesOk(TaskIdList { task_ids }),
                Changed::default(),
            )
        }
        Q::ListTasksAwaitingMerge(mut r) => {
            canonical(&mut r.project_path);
            let tasks = super::awaiting_merge(conn, &r.project_path)?;
            (
                r.project_path,
                A::ListTasksAwaitingMergeOk(TaskList { tasks }),
                Changed::default(),
            )
        }
        Q::ImportTasks(mut r) => {
            canonical(&mut r.project_path);
            let tasks = super::import(conn, &r)?;
            let changed = Changed {
                tasks: !tasks.is_empty(),
                ..Changed::default()
            };
            (
                r.project_path,
                A::ImportTasksOk(TaskList { tasks }),
                changed,
            )
        }
        Q::ListTaskComments(mut r) => {
            canonical(&mut r.project_path);
            let comments = super::list_comments(conn, &r.project_path, r.task_id)?;
            (
                r.project_path,
                A::ListTaskCommentsOk(TaskCommentList { comments }),
                Changed::default(),
            )
        }
        Q::AddTaskComment(mut r) => {
            canonical(&mut r.project_path);
            let comment = super::append(
                conn,
                &r.project_path,
                r.task_id,
                &r.comment.kind,
                &r.comment.author,
                r.comment.body.as_deref(),
                r.comment.external_ref.as_deref(),
                r.comment.phase.as_deref(),
            )?;
            (
                r.project_path,
                A::AddTaskCommentOk(comment),
                thread(r.task_id),
            )
        }
        // Attachments, relationships and instructions are not the thread: a window learns of them
        // from `TasksChanged`, as it does of anything else about a task.
        Q::ListTaskAttachments(mut r) => {
            canonical(&mut r.project_path);
            let attachments = super::list_attachments(conn, &r.project_path, r.task_id)?;
            let reply = A::ListTaskAttachmentsOk(TaskAttachmentList { attachments });
            (r.project_path, reply, Changed::default())
        }
        Q::AddTaskAttachment(mut r) => {
            canonical(&mut r.project_path);
            let attachment =
                super::add_attachment(conn, &r.project_path, r.task_id, &r.filename, &r.file_path)?;
            (r.project_path, A::AddTaskAttachmentOk(attachment), tasks)
        }
        Q::DeleteTaskAttachment(mut r) => {
            canonical(&mut r.project_path);
            super::delete_attachment(conn, &r.project_path, r.attachment_id)?;
            (r.project_path, A::DeleteTaskAttachmentOk, tasks)
        }
        Q::ListTaskRelationships(mut r) => {
            canonical(&mut r.project_path);
            let relationships = super::list_relationships(conn, &r.project_path, r.task_id)?;
            let reply = A::ListTaskRelationshipsOk(TaskRelationshipList { relationships });
            (r.project_path, reply, Changed::default())
        }
        Q::AddTaskRelationship(mut r) => {
            canonical(&mut r.project_path);
            let relationship = super::add_relationship(
                conn,
                &r.project_path,
                r.from_task_id,
                r.to_task_id,
                &r.relationship_type,
            )?;
            (
                r.project_path,
                A::AddTaskRelationshipOk(relationship),
                tasks,
            )
        }
        Q::DeleteTaskRelationship(mut r) => {
            canonical(&mut r.project_path);
            super::delete_relationship(conn, &r.project_path, r.relationship_id)?;
            (r.project_path, A::DeleteTaskRelationshipOk, tasks)
        }
        Q::ListTaskInstructions(mut r) => {
            canonical(&mut r.project_path);
            let instructions = super::list_instructions(conn, &r.project_path, r.task_id)?;
            let reply = A::ListTaskInstructionsOk(TaskInstructionList { instructions });
            (r.project_path, reply, Changed::default())
        }
        Q::AddTaskInstruction(mut r) => {
            canonical(&mut r.project_path);
            let instruction =
                super::add_instruction(conn, &r.project_path, r.task_id, &r.content, &r.source)?;
            (r.project_path, A::AddTaskInstructionOk(instruction), tasks)
        }
        Q::ListWorktrees(mut r) => {
            canonical(&mut r.project_path);
            let worktrees = worktrees::list(conn, &r.project_path, r.task_id)?;
            (
                r.project_path,
                A::ListWorktreesOk(WorktreeList { worktrees }),
                Changed::default(),
            )
        }
        Q::GetWorktree(mut r) => {
            canonical(&mut r.project_path);
            let worktree = worktrees::get(conn, &r.project_path, r.worktree_id)?;
            let reply = A::GetWorktreeOk(OptionalWorktree { worktree });
            (r.project_path, reply, Changed::default())
        }
        Q::InsertWorktree(mut r) => {
            canonical(&mut r.project_path);
            let worktree = worktrees::insert(conn, &r)?;
            (r.project_path, A::InsertWorktreeOk(worktree), worktree_rows)
        }
        Q::UpdateWorktree(mut r) => {
            canonical(&mut r.project_path);
            let worktree = worktrees::update(conn, &r)?;
            (r.project_path, A::UpdateWorktreeOk(worktree), worktree_rows)
        }
        Q::DeleteWorktrees(mut r) => {
            canonical(&mut r.project_path);
            let deleted = worktrees::delete(conn, &r.project_path, &r.worktree_ids)? > 0;
            // A task pinned to a deleted worktree loses the pin, by trigger.
            let changed = Changed {
                tasks: deleted,
                worktrees: deleted,
                ..Changed::default()
            };
            (r.project_path, A::DeleteWorktreesOk, changed)
        }
        Q::ClaimWorktreeForTask(mut r) => {
            canonical(&mut r.project_path);
            let worktree = worktrees::claim_for_task(conn, &r)?;
            (
                r.project_path,
                A::ClaimWorktreeForTaskOk(worktree),
                worktree_rows,
            )
        }
        // A review is about its task, so its change is the task's.
        Q::GetTaskReview(mut r) => {
            canonical(&mut r.project_path);
            let review = reviews::get_review(conn, &r.project_path, r.task_id)?;
            let reply = A::GetTaskReviewOk(OptionalTaskReview { review });
            (r.project_path, reply, Changed::default())
        }
        Q::SaveTaskReview(mut r) => {
            canonical(&mut r.project_path);
            let review_id = reviews::save_review(conn, &r)?;
            let reply = A::SaveTaskReviewOk(SaveTaskReviewResponse { review_id });
            (r.project_path, reply, tasks)
        }
        Q::ClearTaskReview(mut r) => {
            canonical(&mut r.project_path);
            reviews::clear_review(conn, &r.project_path, r.task_id)?;
            (r.project_path, A::ClearTaskReviewOk, tasks)
        }
        _ => return Err("not a task, worktree or review request".to_string()),
    };

    let mut pushes = Vec::new();
    if changed.tasks {
        pushes.push(A::TasksChanged(ProjectRef {
            project_path: project_path.clone(),
        }));
    }
    if let Some(task_id) = changed.comments_of {
        pushes.push(A::TaskCommentsChanged(TaskRef {
            project_path: project_path.clone(),
            task_id,
        }));
    }
    if changed.worktrees {
        pushes.push(A::WorktreesChanged(ProjectRef { project_path }));
    }
    Ok((reply, pushes))
}
