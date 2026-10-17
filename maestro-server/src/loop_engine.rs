//! A loop task between two iterations: the worker's session closed, its work committed, the sealed
//! checks run with no session live, the judge asked once every command passes, and the next step
//! decided. See `docs/loops-plan.md`, phases 1 and 2.
//!
//! Everything here runs off the main loop. The one thing the loop has to do, closing the iteration's
//! session, goes to it through `Settle::LoopSessionClose`, and the engine waits for the close
//! before any sealed file reaches the disk.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use maestro_protocol::{
    ApplyTaskTransitionRequest, LoopCheck, LoopCheckState, LoopConfig, LoopHalt, LoopHiddenFile,
    LoopIteration, LoopIterationOutcome, LoopSummary, NewTaskComment, PhaseStatus, RunMode,
    ServerRequest, ServerResponse, Task, TaskBall, TaskPhase, TaskRef, TaskTransition,
    TransitionGuard,
};

use crate::command_ext::NoConsoleWindow;
use crate::helpers::{broadcast, send_diag};
use crate::project_store::Store;
use crate::task_store::loops::{self, Committed};
use crate::turn::TurnFacts;
use crate::worktree::git;

/// Where the hidden files are written while the checks run, inside `.maestro/`, which git ignores.
const SEALED_DIR: &str = ".maestro/loop/sealed";
/// How much of a command's output is kept, from the end.
const TAIL_LINES: usize = 200;
const LINE_CHARS: usize = 2000;
/// How much failing output an iteration keeps for the next one's prompt.
const OUTPUT_CHARS: usize = 32 * 1024;
const FAILURES_IN_A_ROW: usize = 3;
/// How long the output of a command that exited is still read, for a child it left holding the
/// pipe open.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// What a loop session was started for, kept in its role meta under `loop`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoopSession {
    Iteration(i32),
    /// The judge, deciding these checks, by id in the order its prompt numbers them, at `sha`.
    Judge {
        checks: Vec<i32>,
        sha: String,
    },
}

/// The loop session `session` is, from its role meta.
pub(crate) fn session_of(session: &crate::sessions::ActiveSession) -> Option<LoopSession> {
    let role = session.project.as_ref()?.meta.role.as_deref()?;
    let value: serde_json::Value = serde_json::from_str(role).ok()?;
    serde_json::from_value(value.get("loop")?.clone()).ok()
}

/// A loop session's turn ended.
pub(crate) struct LoopEnd {
    pub project_path: String,
    pub task_id: i32,
    pub session: LoopSession,
    pub session_id: String,
    pub stop_reason: String,
    pub facts: TurnFacts,
    /// The agent refused the turn for a usage limit; its gate opens then.
    pub limited_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Finish the iteration, or read the judge, off the loop. What follows is the drain's to start.
pub(crate) fn spawn(store: Store, stdout: crate::ClientOut, end: LoopEnd) {
    tokio::spawn(Box::pin(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
        let path = crate::automations::canonical_project_path(&end.project_path);
        // The pipeline's rule: a turn the user stopped, or one cut short, ends nothing.
        let cut_short = end.facts.user_interrupted
            || matches!(end.stop_reason.as_str(), "cancelled" | "auth_required");
        if !cut_short {
            match end.session.clone() {
                LoopSession::Iteration(n) => {
                    Box::pin(iteration_ended(&store, &stdout, &everyone, &path, n, end)).await
                }
                LoopSession::Judge { checks, sha } => {
                    let judged = judge_ended(&store, &stdout, &everyone, &path, &checks, &sha, end);
                    Box::pin(judged).await
                }
            }
        }
        crate::scheduler::request_drain(&path);
    }));
}

async fn iteration_ended(
    store: &Store,
    stdout: &crate::ClientOut,
    everyone: &crate::ClientOut,
    path: &str,
    n: i32,
    end: LoopEnd,
) {
    let read = {
        let conn = store.lock().await;
        crate::task_store::get(&conn, path, end.task_id).and_then(|task| {
            Ok(task.zip(running(&loops::list_iterations(&conn, path, end.task_id)?)))
        })
    };
    let (task, iteration) = match read {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => {
            send_diag("warn", format!("[loop] task {}: {e}", end.task_id));
            return;
        }
    };
    let working = task.phase == Some(TaskPhase::Iterating)
        && matches!(
            task.phase_status,
            Some(PhaseStatus::Running | PhaseStatus::Blocked)
        );
    if !working || iteration.n != n {
        send_diag(
            "debug",
            format!(
                "[loop] ignoring the end of iteration {n} of task {}, not the one running",
                end.task_id
            ),
        );
        return;
    }
    if !claim_end(path, task.id, &iteration) {
        return;
    }
    close(stdout, &end.session_id).await;
    let ended = Ended {
        summary: end.facts.closing_message.as_deref(),
        agent_failed: end.stop_reason != "end_turn",
        git_commands: &end.facts.git_commands,
        cut: end.limited_until.map(Cut::Limit),
    };
    finish(store, everyone, path, &task, &iteration, ended).await;
}

/// Iterations this process has ended, by attempt. A Build closed for running too long can still
/// end its turn on its own in the same moment, and only the first of the two may finish it. Never
/// cleared, since an attempt ends once.
// ponytail: one small entry per iteration for the daemon's lifetime; prune on finish if it matters.
static ENDED: LazyLock<Mutex<HashSet<(String, i32, i32, i32)>>> = LazyLock::new(Default::default);

/// Claim the ending of `iteration`: false when it was already claimed.
fn claim_end(path: &str, task_id: i32, iteration: &LoopIteration) -> bool {
    let key = (path.to_string(), task_id, iteration.n, iteration.attempt);
    ENDED.lock().unwrap_or_else(|e| e.into_inner()).insert(key)
}

/// The judge's turn ended: its verdicts recorded, then sign-off with its digest, or another
/// iteration with its reasons.
async fn judge_ended(
    store: &Store,
    stdout: &crate::ClientOut,
    everyone: &crate::ClientOut,
    path: &str,
    checks: &[i32],
    sha: &str,
    end: LoopEnd,
) {
    let task = match crate::task_store::get(&*store.lock().await, path, end.task_id) {
        Ok(Some(task)) => task,
        Ok(None) => return,
        Err(e) => {
            send_diag("warn", format!("[loop] task {}: {e}", end.task_id));
            return;
        }
    };
    let judging = task.phase == Some(TaskPhase::Judging)
        && matches!(
            task.phase_status,
            Some(PhaseStatus::Running | PhaseStatus::Blocked)
        );
    if !judging {
        send_diag(
            "debug",
            format!(
                "[loop] ignoring a judge's turn end on task {}, not judging",
                task.id
            ),
        );
        return;
    }
    close(stdout, &end.session_id).await;
    // Judged again in a fresh session once the gate opens.
    if let Some(until) = end.limited_until {
        let note = crate::agent_gate::note(until);
        let guard = TransitionGuard::Phase(TaskPhase::Judging);
        apply(
            store,
            everyone,
            path,
            task.id,
            TaskTransition::UsageLimited,
            guard,
            Some(note),
        )
        .await;
        return;
    }
    if end.stop_reason != "end_turn" {
        let why = format!(
            "The judge stopped before it decided: its turn ended with \"{}\".",
            end.stop_reason
        );
        stop(store, everyone, path, task.id, TaskPhase::Judging, &why).await;
        return;
    }

    let reply = end.facts.closing_message.unwrap_or_default();
    let judged: Vec<(i32, bool, String)> = checks
        .iter()
        .zip(judge_verdicts(&reply, checks.len()))
        .map(|(&id, verdict)| match verdict {
            Some((passed, reason)) => (id, passed, reason),
            None => (
                id,
                false,
                format!(
                    "The judge gave no verdict on this check. Its answer:\n\n{}",
                    tail_chars(reply.trim(), OUTPUT_CHARS)
                ),
            ),
        })
        .collect();
    let iterations = {
        let mut conn = store.lock().await;
        if let Err(e) = loops::record_judged(&mut conn, path, task.id, sha, &judged) {
            send_diag("warn", format!("[loop] task {}: {e}", task.id));
        }
        loops::list_iterations(&conn, path, task.id).unwrap_or_default()
    };
    let failed = judged.iter().filter(|(_, passed, _)| !passed).count();
    if failed > 0 {
        let step = Step::Judged {
            failed,
            of: judged.len(),
        };
        conclude(store, everyone, path, task.id, TaskPhase::Judging, step).await;
        return;
    }
    let n = iterations.last().map_or(0, |i| i.n);
    let comment = match digest_of(&reply) {
        Some(digest) => {
            let found = maestro_protocol::loop_sealed_findings(&iterations);
            let body = match found.is_empty() {
                true => digest,
                false => format!(
                    "{digest}\n\nSealed paths, from the loop's record:\n\n- {}",
                    found.join("\n- ")
                ),
            };
            entry("digest", "judge", body)
        }
        None => entry(
            "note",
            "maestro",
            format!("The judge passes every check after iteration {n}, but wrote no digest."),
        ),
    };
    apply(
        store,
        everyone,
        path,
        task.id,
        TaskTransition::LoopChecksPassed,
        TransitionGuard::Phase(TaskPhase::Judging),
        Some(comment),
    )
    .await;
}

/// Each check's verdict, by its number from 1: passed or not, and the reason. The first line
/// naming a number wins, and decorations around it (`**1. PASS**:`) are ignored.
fn judge_verdicts(reply: &str, count: usize) -> Vec<Option<(bool, String)>> {
    let mut verdicts = vec![None; count];
    let decoration = |c: char| !c.is_ascii_alphanumeric();
    for line in reply.lines() {
        let line = line.trim_start_matches(decoration);
        let digits = line.chars().take_while(char::is_ascii_digit).count();
        let Ok(number) = line[..digits].parse::<usize>() else {
            continue;
        };
        let rest = line[digits..].trim_start_matches(decoration);
        let word: String = rest.chars().take_while(char::is_ascii_alphabetic).collect();
        let passed = match word.to_ascii_uppercase().as_str() {
            "PASS" | "PASSED" | "PASSES" => true,
            "FAIL" | "FAILED" | "FAILS" => false,
            _ => continue,
        };
        let reason = rest[word.len()..]
            .trim_start_matches(|c: char| c.is_whitespace() || ":-*).—–".contains(c))
            .trim_end_matches(|c: char| c.is_whitespace() || c == '*')
            .to_string();
        if let Some(slot @ None) = number.checked_sub(1).and_then(|i| verdicts.get_mut(i)) {
            *slot = Some((passed, reason));
        }
    }
    verdicts
}

/// What follows the judge's `## Digest` line, if it wrote one.
fn digest_of(reply: &str) -> Option<String> {
    let mut lines = reply.lines();
    lines.find(|line| {
        let words: String = line.chars().filter(char::is_ascii_alphanumeric).collect();
        words.eq_ignore_ascii_case("digest")
    })?;
    let digest = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    (!digest.is_empty()).then_some(digest)
}

/// The judge's view of the loop's work, as its prompt shows it: `git diff --stat` from the base.
pub(crate) async fn diff_stat(dir: &str, task: &Task) -> Option<String> {
    let base = match task.base_branch.trim() {
        "" => task.execution_start_sha.clone()?,
        base => base.to_string(),
    };
    git(dir, &["diff", "--stat", &format!("{base}...HEAD")])
        .await
        .ok()
}

/// The live iteration: the newest row still running.
fn running(iterations: &[LoopIteration]) -> Option<LoopIteration> {
    iterations
        .iter()
        .rev()
        .find(|i| i.outcome == LoopIterationOutcome::Running)
        .cloned()
}

/// Close the iteration's session and wait until it is closed.
pub(crate) async fn close(stdout: &crate::ClientOut, session_id: &str) {
    let Some(settle_tx) = crate::dispatch::SETTLE_TX.get() else {
        return;
    };
    let (closed, done) = tokio::sync::oneshot::channel();
    let sent = settle_tx.send(crate::dispatch::Settle::LoopSessionClose {
        session_id: session_id.to_string(),
        stdout: Arc::clone(stdout),
        closed,
    });
    if sent.is_ok() {
        let _ = done.await;
    }
}

/// After a restart: an iteration whose session closed before its work was committed.
pub(crate) async fn finish_orphan(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
) {
    let read = {
        let conn = store.lock().await;
        crate::task_store::get(&conn, path, task_id)
            .and_then(|task| Ok(task.zip(running(&loops::list_iterations(&conn, path, task_id)?))))
    };
    match read {
        Ok(Some((task, iteration))) => {
            finish(store, everyone, path, &task, &iteration, Ended::default()).await
        }
        Ok(None) => {}
        Err(e) => send_diag("warn", format!("[loop] task {task_id} at startup: {e}")),
    }
}

/// What the worker's turn left besides its files.
#[derive(Default)]
struct Ended<'a> {
    /// Its last words.
    summary: Option<&'a str>,
    agent_failed: bool,
    git_commands: &'a [String],
    /// Cut off before it ended: what it wrote is kept as a WIP commit, and the iteration runs
    /// again uncounted.
    cut: Option<Cut>,
}

/// Why an iteration was cut off.
#[derive(Clone, Copy)]
enum Cut {
    /// A usage limit refused it; the gate opens then.
    Limit(chrono::DateTime<chrono::Utc>),
    /// The user stopped the loop, which has halted already.
    Stopped,
}

/// Discard what the worker wrote where it may not, commit the rest, and check it.
async fn finish(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task: &Task,
    iteration: &LoopIteration,
    ended: Ended<'_>,
) {
    let task_id = task.id;
    // The worker said it is blocked: its turn ended as it meant to, whatever cut it after, unless
    // the user stopped the loop.
    let blocked = iteration
        .blocked
        .as_deref()
        .filter(|_| !matches!(ended.cut, Some(Cut::Stopped)));
    let ended = Ended {
        cut: ended.cut.filter(|_| blocked.is_none()),
        ..ended
    };
    let context = worktree_dir(store, path, task_id).await;
    let dir = crate::worktree::sandbox_dir(path, task_id);
    let Some(context) = context.filter(|_| Path::new(&dir).exists()) else {
        stop(
            store,
            everyone,
            path,
            task_id,
            TaskPhase::Iterating,
            "The loop's worktree or its sandbox is gone.",
        )
        .await;
        return;
    };
    let config = task.loop_config.clone().unwrap_or_default();
    // Removed before the sparse checkout is set again, which then marks them cleanly: set first,
    // and a sealed file the worker changed would stay, and its removal be staged.
    let touched_sealed = remove_sealed(&dir, &config.sealed_paths).await;
    let resealed = crate::worktree::seal(&dir, task).await;
    let committed = match resealed {
        Ok(()) => {
            let message = match ended.cut {
                Some(_) => format!("loop: iteration {}, cut off (WIP)", iteration.n),
                None => format!("loop: iteration {}", iteration.n),
            };
            commit(
                &dir,
                &message,
                Duration::from_secs(config.check_timeout_secs.into()),
            )
            .await
        }
        Err(e) => Err(e),
    };
    // Into the loop's worktree, where the checks run and the work is reviewed. A failure halts the
    // loop with the commit kept in the sandbox, merged again when the next iteration starts.
    if let Ok(Some(Committed {
        commit_sha: Some(sha),
        ..
    })) = &committed
    {
        if let Err(e) = crate::worktree::merge_back(&context, sha).await {
            conflict(store, everyone, path, task_id, iteration, &e).await;
            return;
        }
    }
    let row = Committed {
        touched_sealed,
        peeks: peeks(ended.git_commands, &config.sealed_paths),
        ..committed.clone().ok().flatten().unwrap_or_default()
    };
    if let Err(e) = loops::record_commit(
        &*store.lock().await,
        path,
        task_id,
        iteration,
        ended.summary,
        &row,
    ) {
        send_diag("warn", format!("[loop] task {task_id}: {e}"));
    }
    if touched_sealed {
        send_diag(
            "info",
            format!(
                "[loop] iteration {} of task {task_id} wrote at a sealed path",
                iteration.n
            ),
        );
    }

    if let Some(cut) = ended.cut {
        let interrupted = LoopIterationOutcome::Interrupted;
        let recorded = loops::record_outcome(
            &*store.lock().await,
            path,
            task_id,
            iteration,
            interrupted,
            None,
        );
        if let Err(e) = recorded {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
        }
        if let Cut::Limit(until) = cut {
            let note = crate::agent_gate::note(until);
            let guard = TransitionGuard::Phase(TaskPhase::Iterating);
            apply(
                store,
                everyone,
                path,
                task_id,
                TaskTransition::UsageLimited,
                guard,
                Some(note),
            )
            .await;
        }
        return;
    }
    if let Some(reason) = blocked {
        let (outcome, halt) = (LoopIterationOutcome::Blocked, LoopHalt::Blocked);
        let recorded = {
            let conn = store.lock().await;
            loops::record_outcome(&conn, path, task_id, iteration, outcome, None)
                .and_then(|()| loops::set_halt(&conn, path, task_id, halt))
        };
        if let Err(e) = recorded {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
        }
        let note = format!(
            "Iteration {} is blocked and asks for you:

{}",
            iteration.n,
            reason.trim()
        );
        apply(
            store,
            everyone,
            path,
            task_id,
            TaskTransition::LoopHalted,
            TransitionGuard::Phase(TaskPhase::Iterating),
            Some(note_entry(note)),
        )
        .await;
        return;
    }
    let (outcome, output) = match committed {
        _ if ended.agent_failed => (LoopIterationOutcome::Failed, None),
        Err(e) => (
            LoopIterationOutcome::Failed,
            Some(format!(
                "The iteration's commit failed:\n{}",
                tail_chars(&e, OUTPUT_CHARS)
            )),
        ),
        Ok(None) => (LoopIterationOutcome::Empty, None),
        Ok(Some(_)) => {
            let moved = apply(
                store,
                everyone,
                path,
                task_id,
                TaskTransition::LoopChecking,
                TransitionGuard::Phase(TaskPhase::Iterating),
                None,
            )
            .await;
            if moved {
                Box::pin(check(store, everyone, path, task_id)).await;
            }
            return;
        }
    };
    if let Err(e) = loops::record_outcome(
        &*store.lock().await,
        path,
        task_id,
        iteration,
        outcome,
        output.as_deref(),
    ) {
        send_diag("warn", format!("[loop] task {task_id}: {e}"));
    }
    conclude(
        store,
        everyone,
        path,
        task_id,
        TaskPhase::Iterating,
        Step::Iteration,
    )
    .await;
}

/// The iteration's commit could not be merged back: the loop halts for the user, with git's reason.
async fn conflict(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    iteration: &LoopIteration,
    why: &str,
) {
    let output = format!(
        "The iteration's commit could not be merged into the loop's worktree:\n{}",
        tail_chars(why, OUTPUT_CHARS)
    );
    let recorded = {
        let conn = store.lock().await;
        let failed = LoopIterationOutcome::Failed;
        loops::record_outcome(&conn, path, task_id, iteration, failed, Some(&output))
            .and_then(|()| loops::set_halt(&conn, path, task_id, LoopHalt::Conflict))
    };
    if let Err(e) = recorded {
        send_diag("warn", format!("[loop] task {task_id}: {e}"));
    }
    let note = format!(
        "Iteration {} could not be merged into the loop's worktree:\n\n{}\n\nCommit or revert what \
         is in the way there, then resume. The iteration's work is kept and merged first.",
        iteration.n,
        why.trim()
    );
    apply(
        store,
        everyone,
        path,
        task_id,
        TaskTransition::LoopHalted,
        TransitionGuard::Phase(TaskPhase::Iterating),
        Some(note_entry(note)),
    )
    .await;
}

// ponytail: a substring match, so a sealed `tests` also matches `git log -- latests.rs`. Parse the
// command's paths if the false hits get in the way.
/// The commands that name a sealed path.
fn peeks(commands: &[String], sealed: &[String]) -> Vec<String> {
    commands
        .iter()
        .filter(|command| {
            sealed
                .iter()
                .any(|path| command.contains(path.trim_end_matches('/')))
        })
        .cloned()
        .collect()
}

/// `RerunLoopChecks`, `ReadLoopNotes`, `AnswerLoopProposal`, `OpenAgentGate`, `PauseLoop`,
/// `StopLoop` and `RestartLoop`: the reply, and the pushes owed after it.
pub(crate) async fn answer(
    request: ServerRequest,
    store: Option<&Store>,
    stdout: &crate::ClientOut,
) -> (ServerResponse, Vec<ServerResponse>) {
    let Some(store) = store else {
        let error = crate::helpers::error_response(crate::project_store::UNAVAILABLE.to_string());
        return (error, Vec::new());
    };
    let (task, rerun) = match request {
        ServerRequest::RerunLoopChecks(task) => (task, true),
        ServerRequest::ReadLoopNotes(task) => (task, false),
        ServerRequest::AnswerLoopProposal(request) => {
            return match Box::pin(answer_proposal(store, request)).await {
                Ok(answered) => answered,
                Err(e) => (crate::helpers::error_response(e), Vec::new()),
            };
        }
        ServerRequest::OpenAgentGate(request) => {
            return (
                crate::agent_gate::answer_open(store, &request.agent_id).await,
                Vec::new(),
            );
        }
        ServerRequest::PauseLoop(task) => {
            return match Box::pin(hold_loop(store, stdout, task, LoopHalt::Paused)).await {
                Ok(pushes) => (ServerResponse::PauseLoopOk, pushes),
                Err(e) => (crate::helpers::error_response(e), Vec::new()),
            };
        }
        ServerRequest::StopLoop(task) => {
            return match Box::pin(hold_loop(store, stdout, task, LoopHalt::Stopped)).await {
                Ok(pushes) => (ServerResponse::StopLoopOk, pushes),
                Err(e) => (crate::helpers::error_response(e), Vec::new()),
            };
        }
        ServerRequest::RestartLoop(request) => {
            return match Box::pin(restart_loop(store, request)).await {
                Ok(pushes) => (ServerResponse::RestartLoopOk, pushes),
                Err(e) => (crate::helpers::error_response(e), Vec::new()),
            };
        }
        _ => {
            return (
                crate::helpers::error_response("not a loop request".to_string()),
                Vec::new(),
            )
        }
    };
    let path = crate::automations::canonical_project_path(&task.project_path);
    if rerun {
        // The answer says the checks started; how they went arrives as the task changes.
        return match loops::claim_recheck(&mut *store.lock().await, &path, task.task_id) {
            Ok(_) => {
                self::rerun(
                    Arc::clone(store),
                    Arc::clone(stdout),
                    path.clone(),
                    task.task_id,
                );
                let changed = ServerResponse::TasksChanged(maestro_protocol::ProjectRef {
                    project_path: path,
                });
                (ServerResponse::RerunLoopChecksOk, vec![changed])
            }
            Err(e) => (crate::helpers::error_response(e), Vec::new()),
        };
    }
    let notes = Path::new(&crate::worktree::sandbox_dir(&path, task.task_id))
        .join(".maestro/loop/PROGRESS.md");
    let content = tokio::fs::read_to_string(notes).await.ok();
    let notes = maestro_protocol::LoopNotes { content };
    (ServerResponse::ReadLoopNotesOk(notes), Vec::new())
}

/// `PauseLoop` and `StopLoop`. A loop waiting on the drain halts now. Stop cuts a running iteration
/// or judge, keeping the iteration's work as a WIP commit. A pause, and a stop while the checks
/// run, is taken once the running step ends.
async fn hold_loop(
    store: &Store,
    stdout: &crate::ClientOut,
    task: TaskRef,
    halt: LoopHalt,
) -> Result<Vec<ServerResponse>, String> {
    let path = crate::automations::canonical_project_path(&task.project_path);
    let task_id = task.task_id;
    let (task, iteration) = {
        let conn = store.lock().await;
        let task = crate::task_store::get(&conn, &path, task_id)?
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        (
            task,
            running(&loops::list_iterations(&conn, &path, task_id)?),
        )
    };
    if task.run_mode != RunMode::Loop {
        return Err("Only a loop can be paused or stopped this way".to_string());
    }
    let everyone = crate::client_sink::ClientSink::everyone(stdout).await;
    let live = matches!(
        task.phase_status,
        Some(PhaseStatus::Running | PhaseStatus::Blocked)
    );
    let waiting = task.phase_status == Some(PhaseStatus::Waiting) && task.ball == TaskBall::Agent;
    let note = Some(note_entry(format!(
        "{}, as you asked.",
        halted_words(Some(halt))
    )));
    match task.phase {
        Some(TaskPhase::Iterating | TaskPhase::Judging) if waiting => {
            loops::set_halt(&*store.lock().await, &path, task_id, halt)?;
            let guard = TransitionGuard::Ball(TaskBall::Agent);
            apply(
                store,
                &everyone,
                &path,
                task_id,
                TaskTransition::LoopHalted,
                guard,
                note,
            )
            .await;
            Ok(Vec::new())
        }
        Some(phase @ (TaskPhase::Iterating | TaskPhase::Judging))
            if live && halt == LoopHalt::Stopped =>
        {
            // Halted first, so the end of the turn the close cuts finds nothing running.
            loops::set_halt(&*store.lock().await, &path, task_id, halt)?;
            let guard = TransitionGuard::AgentRunning;
            let event = TaskTransition::LoopHalted;
            if !apply(store, &everyone, &path, task_id, event, guard, note).await {
                return Ok(Vec::new());
            }
            // Off the loop: this is answered inside the main loop's dispatch, and a close is
            // settled by that same loop, so awaiting it here would wait on itself.
            let sessions = live_sessions(store, &path, task_id).await;
            let (store, stdout) = (Arc::clone(store), Arc::clone(stdout));
            tokio::spawn(Box::pin(async move {
                for session_id in sessions {
                    close(&stdout, &session_id).await;
                }
                if let (TaskPhase::Iterating, Some(iteration)) = (phase, iteration) {
                    let ended = Ended {
                        cut: Some(Cut::Stopped),
                        ..Ended::default()
                    };
                    let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
                    Box::pin(finish(&store, &everyone, &path, &task, &iteration, ended)).await;
                }
            }));
            Ok(Vec::new())
        }
        Some(TaskPhase::Iterating | TaskPhase::Checking | TaskPhase::Judging) if live => {
            loops::set_hold(&*store.lock().await, &path, task_id, Some(halt))?;
            let changed =
                ServerResponse::TasksChanged(maestro_protocol::ProjectRef { project_path: path });
            Ok(vec![changed])
        }
        _ => Err("This loop is not running".to_string()),
    }
}

/// `RestartLoop`: the loop's branch reset to the commit it started from, its sandbox removed, and
/// its iterations, check results, halt and streaks cleared, parked in Planning or Queue. Only a
/// loop with nothing running, so no session or check is writing while the branch moves.
async fn restart_loop(
    store: &Store,
    request: maestro_protocol::RestartLoopRequest,
) -> Result<Vec<ServerResponse>, String> {
    use maestro_protocol::TaskStatus;
    let path = crate::automations::canonical_project_path(&request.project_path);
    let task_id = request.task_id;
    if !matches!(request.status, TaskStatus::Planning | TaskStatus::Queue) {
        return Err("A loop restarts in Planning or Queue".to_string());
    }
    let task = crate::task_store::get(&*store.lock().await, &path, task_id)?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    if task.run_mode != RunMode::Loop {
        return Err("Only a loop restarts this way".to_string());
    }
    let busy = matches!(
        task.phase_status,
        Some(PhaseStatus::Running | PhaseStatus::Blocked)
    ) || matches!(task.phase, Some(TaskPhase::Spawning | TaskPhase::Checking));
    if busy {
        return Err("Stop the loop before restarting it".to_string());
    }
    if let (Some(dir), Some(start)) = (
        worktree_dir(store, &path, task_id).await,
        task.execution_start_sha.as_deref(),
    ) {
        if Path::new(&dir).exists() {
            git(&dir, &["reset", "--hard", start]).await?;
            git(&dir, &["clean", "-fd"]).await?;
        }
    }
    crate::worktree::remove_sandbox(&path, task_id).await?;
    let mut conn = store.lock().await;
    loops::clear_progress(&mut conn, &path, task_id)?;
    let short: String = task
        .execution_start_sha
        .as_deref()
        .unwrap_or_default()
        .chars()
        .take(8)
        .collect();
    let note = if short.is_empty() {
        "Restarted from scratch: the iterations and check results are cleared.".to_string()
    } else {
        format!(
            "Restarted from scratch: the branch is back at {short}, where the loop started, and              the iterations and check results are cleared."
        )
    };
    let move_back = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: path.clone(),
        task_id,
        event: TaskTransition::ManualMove(request.status),
        guard: TransitionGuard::Always,
        update: None,
        comment: Some(note_entry(note)),
    });
    let (_, pushes) = crate::task_store::requests::answer(&mut conn, move_back)?;
    Ok(pushes)
}

/// The routing ids of the task's sessions that are up.
async fn live_sessions(store: &Store, path: &str, task_id: i32) -> Vec<String> {
    let conn = store.lock().await;
    let found = conn
        .prepare(
            "SELECT session_id FROM sessions
             WHERE project_path = ?1 AND task_id = ?2 AND closed_at IS NULL
               AND session_id IS NOT NULL",
        )
        .and_then(|mut statement| {
            statement
                .query_map(rusqlite::params![path, task_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()
        });
    found.unwrap_or_else(|e| {
        send_diag("warn", format!("[loop] sessions of task {task_id}: {e}"));
        Vec::new()
    })
}

/// Accept or reject a proposed check. Accepting seals the paths it names, each of which has to be in
/// the loop's worktree, where the checks run, and the sandbox drops them at once.
async fn answer_proposal(
    store: &Store,
    mut request: maestro_protocol::AnswerLoopProposalRequest,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    let path = crate::automations::canonical_project_path(&request.project_path);
    request.project_path = path.clone();
    let task_id = request.task_id;
    let task = crate::task_store::get(&*store.lock().await, &path, task_id)?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    if request.accept.is_none() {
        request.seal.clear();
    }
    let mut sealing = Vec::new();
    for wanted in &request.seal {
        sealing.push(sealable(store, &path, Some(task_id), &task.base_branch, wanted).await?);
    }
    request.seal = sealing;
    let sealed = !request.seal.is_empty();
    let answered = crate::task_store::requests::answer(
        &mut *store.lock().await,
        ServerRequest::AnswerLoopProposal(request),
    )?;
    let sandbox = crate::worktree::sandbox_dir(&path, task_id);
    if sealed && Path::new(&sandbox).exists() {
        let task = crate::task_store::get(&*store.lock().await, &path, task_id)?;
        if let Some(task) = task {
            if let Err(e) = crate::worktree::seal(&sandbox, &task).await {
                send_diag("warn", format!("[loop] task {task_id}: {e}"));
            }
        }
    }
    Ok(answered)
}

/// `wanted` as a sealed path, which has to be committed where the checks run: in the loop's
/// worktree, or before it exists, on `base_branch`, which it starts from.
pub(crate) async fn sealable(
    store: &Store,
    path: &str,
    task_id: Option<i32>,
    base_branch: &str,
    wanted: &str,
) -> Result<String, String> {
    let wanted = loops::relative_path(wanted, true)?;
    let context = match task_id {
        Some(task_id) => worktree_dir(store, path, task_id).await,
        None => None,
    };
    let (dir, at) = match context {
        Some(dir) => (dir, "HEAD"),
        None => (
            path.to_string(),
            match base_branch.trim() {
                "" => "HEAD",
                base => base,
            },
        ),
    };
    let listed = git(
        &dir,
        &[
            "ls-tree",
            "--name-only",
            at,
            "--",
            wanted.trim_end_matches('/'),
        ],
    )
    .await?;
    if listed.trim().is_empty() {
        let place = match at {
            "HEAD" => "the loop's branch",
            base => base,
        };
        return Err(format!(
            "\"{wanted}\" is not committed on {place}, so it cannot be sealed: the checks run \
             against that branch's files. Commit it there first, or add it as a hidden file."
        ));
    }
    Ok(wanted)
}

/// After a restart: checks that died with the daemon run again.
pub(crate) async fn recheck(store: &Store, everyone: &crate::ClientOut, path: &str, task_id: i32) {
    Box::pin(check(store, everyone, path, task_id)).await;
}

/// The user's Re-run checks, once the task is `Checking`: the checks again, on the loop's worktree
/// as it is now, a test the user fixed there included.
pub(crate) fn rerun(store: Store, stdout: crate::ClientOut, path: String, task_id: i32) {
    tokio::spawn(Box::pin(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
        Box::pin(check(&store, &everyone, &path, task_id)).await;
        crate::scheduler::request_drain(&path);
    }));
}

/// Run the checks of a task in `Checking`, record them, and decide.
async fn check(store: &Store, everyone: &crate::ClientOut, path: &str, task_id: i32) {
    let read = {
        let conn = store.lock().await;
        (|| -> Result<_, String> {
            let Some(task) = crate::task_store::get(&conn, path, task_id)? else {
                return Ok(None);
            };
            let checks = loops::list_checks(&conn, path, task_id)?;
            let hidden = loops::list_hidden_files(&conn, path, task_id)?;
            let last = loops::list_iterations(&conn, path, task_id)?.pop();
            Ok(Some((task, checks, hidden, last)))
        })()
    };
    let (task, checks, hidden, last) = match read {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
            return;
        }
    };
    if task.phase != Some(TaskPhase::Checking) {
        return;
    }
    let Some(dir) = worktree_dir(store, path, task_id).await else {
        stop(
            store,
            everyone,
            path,
            task_id,
            TaskPhase::Checking,
            "The loop's worktree is gone.",
        )
        .await;
        return;
    };
    let run = match run_checks(&dir, &task, &checks, &hidden).await {
        Ok(run) => run,
        Err(e) => {
            let note = format!("The checks could not run: {e}");
            stop(store, everyone, path, task_id, TaskPhase::Checking, &note).await;
            return;
        }
    };
    {
        let mut conn = store.lock().await;
        let recorded = loops::record_results(&mut conn, path, task_id, &run.results).and_then(
            |()| match &last {
                Some(last) => loops::record_outcome(
                    &conn,
                    path,
                    task_id,
                    last,
                    LoopIterationOutcome::Checked,
                    Some(&run.output)
                        .filter(|o| !o.is_empty())
                        .map(String::as_str),
                ),
                None => Ok(()),
            },
        );
        if let Err(e) = recorded {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
        }
    }
    conclude(
        store,
        everyone,
        path,
        task_id,
        TaskPhase::Checking,
        Step::Commands(&run),
    )
    .await;
}

/// What just finished, for the verdict and its note.
enum Step<'a> {
    /// An iteration that ran no checks: it changed nothing, or failed.
    Iteration,
    Commands(&'a CheckRun),
    /// Every command passed, and the judge failed `failed` of the `of` checks it decided.
    Judged {
        failed: usize,
        of: usize,
    },
}

/// Where the loop stands once an iteration is recorded, and the transition that says so.
async fn conclude(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    phase: TaskPhase,
    step: Step<'_>,
) {
    let read = {
        let conn = store.lock().await;
        (|| -> Result<_, String> {
            let Some(task) = crate::task_store::get(&conn, path, task_id)? else {
                return Ok(None);
            };
            let iterations = loops::list_iterations(&conn, path, task_id)?;
            let resumed = loops::resumed_at(&conn, path, task_id)?;
            let (judge, _) = loops::to_judge(&conn, path, task_id)?;
            let (_, hold) = loops::halt_and_hold(&conn, path, task_id)?;
            // An iteration that committed nothing leaves the loop on the commit its checks last
            // ran on, so their results still hold.
            let passing = loops::list_checks(&conn, path, task_id)?
                .iter()
                .filter(|c| loops::is_runnable(c))
                .all(|c| c.state == LoopCheckState::Pass);
            Ok(Some((
                task,
                iterations,
                resumed,
                !judge.is_empty(),
                hold,
                passing,
            )))
        })()
    };
    let (task, iterations, resumed, judge, hold, passing) = match read {
        Ok(Some(found)) => found,
        Ok(None) => return,
        Err(e) => {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
            return;
        }
    };
    let config = task.loop_config.clone().unwrap_or_default();
    let run = match step {
        Step::Commands(run) => Some(run),
        _ => None,
    };
    let unchanged = matches!(step, Step::Iteration)
        && iterations.last().map(|i| i.outcome) == Some(LoopIterationOutcome::Empty);
    let verdict = verdict(
        &config,
        &iterations,
        run,
        unchanged && passing,
        resumed.as_deref(),
    );
    let n = iterations.last().map_or(0, |i| i.n);
    // A pause or stop asked for while this step ran is taken before the next one starts.
    let held = match (&verdict, hold) {
        (Verdict::Iterate, Some(hold)) => Some(hold),
        (Verdict::Passed, Some(hold)) if judge => Some(hold),
        _ => None,
    };
    let halt = held.or(match &verdict {
        Verdict::Flaky(_) => Some(LoopHalt::Flaky),
        Verdict::Failing => Some(LoopHalt::Failing),
        Verdict::Stalled => Some(LoopHalt::Stalled),
        Verdict::OutOfIterations => Some(LoopHalt::OutOfIterations),
        Verdict::Passed | Verdict::Iterate => None,
    });
    {
        let conn = store.lock().await;
        let written = match halt {
            Some(halt) => loops::set_halt(&conn, path, task_id, halt),
            None => loops::set_hold(&conn, path, task_id, None),
        };
        if let Err(e) = written {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
        }
    }
    let (event, note) = match &verdict {
        _ if held.is_some() => (
            TaskTransition::LoopHalted,
            format!("{} after iteration {n}, as you asked.", halted_words(held)),
        ),
        Verdict::Flaky(labels) => (
            TaskTransition::PhaseFailed,
            format!(
                "Paused after iteration {n}: {} gave a different result when run again on the same \
                 commit, so it is flaky. Fix it or remove it, then re-run the checks.",
                labels.join(", ")
            ),
        ),
        Verdict::Passed if unchanged && judge => (
            TaskTransition::LoopJudging,
            format!(
                "Iteration {n} changed nothing and every command check already passes, so the                  judge decides the rest."
            ),
        ),
        Verdict::Passed if unchanged => (
            TaskTransition::LoopChecksPassed,
            format!("Iteration {n} changed nothing, and every command check already passes."),
        ),
        Verdict::Passed if judge => (
            TaskTransition::LoopJudging,
            format!(
                "Every command check passes after iteration {n}, so the judge decides the rest."
            ),
        ),
        Verdict::Passed => (
            TaskTransition::LoopChecksPassed,
            format!("Every command check passes after iteration {n}."),
        ),
        Verdict::Failing => (
            TaskTransition::PhaseFailed,
            format!("Stopped: the last {FAILURES_IN_A_ROW} iterations failed."),
        ),
        Verdict::Stalled => (
            TaskTransition::LoopHalted,
            format!(
                "Stopped: {} iterations in a row made no progress.",
                config.stall_limit
            ),
        ),
        Verdict::OutOfIterations => (
            TaskTransition::LoopHalted,
            format!(
                "Stopped: the loop used its {} iterations.",
                config.max_iterations
            ),
        ),
        Verdict::Iterate => (
            TaskTransition::LoopIterate,
            progress_note(n, &iterations, &step),
        ),
    };
    apply(
        store,
        everyone,
        path,
        task_id,
        event,
        TransitionGuard::Phase(phase),
        Some(note_entry(note)),
    )
    .await;
}

fn progress_note(n: i32, iterations: &[LoopIteration], step: &Step<'_>) -> String {
    let last = iterations.last();
    let run = match step {
        Step::Commands(run) => Some(*run),
        Step::Judged { failed, of } => {
            return format!(
                "Iteration {n}: every command check passes, and the judge failed {failed} of {of}."
            )
        }
        Step::Iteration => None,
    };
    match (run, last.map(|i| i.outcome)) {
        (Some(run), _) => {
            let passing = run
                .results
                .iter()
                .filter(|(_, state, _)| *state == LoopCheckState::Pass)
                .count();
            format!(
                "Iteration {n}: {passing} of {} command checks pass.",
                run.results.len()
            )
        }
        (None, Some(LoopIterationOutcome::Empty)) => format!("Iteration {n} changed nothing."),
        (None, _) if last.and_then(|i| i.check_output.as_ref()).is_some() => {
            format!("Iteration {n} could not be committed.")
        }
        (None, _) => format!("Iteration {n} failed."),
    }
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Flaky(Vec<String>),
    Passed,
    Failing,
    Stalled,
    OutOfIterations,
    Iterate,
}

/// What the loop does next, from its iterations, oldest first, and the checks just run. The stall
/// and failure streaks count from `resumed`, when the user last let the loop go on; the budget
/// counts every iteration. `still_passing` is an iteration that changed nothing on a commit every
/// command check already passes: another would only change nothing again.
fn verdict(
    config: &LoopConfig,
    iterations: &[LoopIteration],
    run: Option<&CheckRun>,
    still_passing: bool,
    resumed: Option<&str>,
) -> Verdict {
    if let Some(run) = run {
        if !run.flaky.is_empty() {
            return Verdict::Flaky(run.flaky.clone());
        }
        if run.all_pass {
            return Verdict::Passed;
        }
    }
    if still_passing {
        return Verdict::Passed;
    }
    let (ended, recent) = ended_and_recent(iterations, resumed);
    let failing = recent
        .iter()
        .rev()
        .take_while(|i| i.outcome == LoopIterationOutcome::Failed)
        .count();
    if failing >= FAILURES_IN_A_ROW {
        return Verdict::Failing;
    }
    if stall_streak(&recent) >= config.stall_limit as usize {
        return Verdict::Stalled;
    }
    if ended.iter().filter(|i| i.counted).count() >= config.max_iterations as usize {
        return Verdict::OutOfIterations;
    }
    Verdict::Iterate
}

/// Nothing to commit, or the same checks failing the same way as the last checked iteration.
fn no_progress(checked: Option<&LoopIteration>, iteration: &LoopIteration) -> bool {
    match iteration.outcome {
        LoopIterationOutcome::Empty => true,
        LoopIterationOutcome::Checked => checked.is_some_and(|p| {
            same_output(p.check_output.as_deref(), iteration.check_output.as_deref())
        }),
        _ => false,
    }
}

// ponytail: digits dropped so timings and counters do not read as progress; a check printing
// random words would still look like change. Compare per-check pass/fail sets if that matters.
fn same_output(a: Option<&str>, b: Option<&str>) -> bool {
    let strip = |s: &str| {
        s.chars()
            .filter(|c| !c.is_ascii_digit())
            .collect::<String>()
    };
    match (a, b) {
        (Some(a), Some(b)) => strip(a) == strip(b),
        _ => false,
    }
}

/// The iterations that ended, and of those the ones started since the user last let the loop go
/// on, oldest first.
fn ended_and_recent<'a>(
    iterations: &'a [LoopIteration],
    resumed: Option<&str>,
) -> (Vec<&'a LoopIteration>, Vec<&'a LoopIteration>) {
    let ended: Vec<&LoopIteration> = iterations
        .iter()
        .filter(|i| {
            !matches!(
                i.outcome,
                LoopIterationOutcome::Running | LoopIterationOutcome::Interrupted
            )
        })
        .collect();
    let recent = ended
        .iter()
        .copied()
        .filter(|i| resumed.is_none_or(|at| i.started_at.as_str() > at))
        .collect();
    (ended, recent)
}

/// The latest iterations in a row that made no progress, as the stall limit counts them.
fn stall_streak(recent: &[&LoopIteration]) -> usize {
    (0..recent.len())
        .rev()
        .take_while(|&k| {
            // Measured against the last iteration that was checked: an empty one in between
            // changed nothing to compare.
            let checked = recent[..k]
                .iter()
                .rev()
                .find(|i| i.outcome == LoopIterationOutcome::Checked);
            no_progress(checked.copied(), recent[k])
        })
        .count()
}

/// What the board shows of a loop, read with its task.
pub(crate) fn summary(conn: &rusqlite::Connection, task: &Task) -> Result<LoopSummary, String> {
    let (path, id) = (task.project_path.as_str(), task.id);
    let iterations = loops::list_iterations(conn, path, id)?;
    let checks = loops::list_checks(conn, path, id)?;
    let resumed = loops::resumed_at(conn, path, id)?;
    let (halt, hold) = loops::halt_and_hold(conn, path, id)?;
    let (ended, recent) = ended_and_recent(&iterations, resumed.as_deref());
    let counted: Vec<&LoopIteration> = ended.into_iter().filter(|i| i.counted).collect();
    let waiting = |c: &&LoopCheck| c.proposed && !c.accepted;
    Ok(LoopSummary {
        iteration: iterations.last().map_or(0, |i| i.n),
        counted: counted.len() as i32,
        agent_secs: counted.iter().map(|i| agent_seconds(i)).sum(),
        no_change: stall_streak(&recent) as i32,
        last_summary: iterations.iter().rev().find_map(|i| i.summary.clone()),
        checks: checks
            .iter()
            .filter(|c| !waiting(c))
            .map(|c| c.state)
            .collect(),
        proposals: checks.iter().filter(waiting).count() as i32,
        halt,
        hold,
    })
}

fn halted_words(halt: Option<LoopHalt>) -> &'static str {
    match halt {
        Some(LoopHalt::Stopped) => "Stopped",
        _ => "Paused",
    }
}

fn agent_seconds(iteration: &LoopIteration) -> i64 {
    let at = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (
        at(&iteration.started_at),
        iteration.ended_at.as_deref().and_then(at),
    ) {
        (Some(start), Some(end)) => (end - start).num_seconds().max(0),
        _ => 0,
    }
}

fn duration_words(seconds: u32) -> String {
    match seconds {
        s if s % 3600 == 0 => format!("{}h", s / 3600),
        s if s >= 60 => format!("{}m", s / 60),
        s => format!("{s}s"),
    }
}

fn entry(kind: &str, author: &str, body: String) -> NewTaskComment {
    NewTaskComment {
        kind: kind.to_string(),
        author: author.to_string(),
        body: Some(body),
        external_ref: None,
        phase: None,
    }
}

fn note_entry(body: String) -> NewTaskComment {
    entry("note", "maestro", body)
}

/// One guarded transition with an entry in the thread, pushed. Whether it applied.
async fn apply(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    comment: Option<NewTaskComment>,
) -> bool {
    let request = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: path.to_string(),
        task_id,
        event,
        guard,
        update: None,
        comment,
    });
    let answered = crate::task_store::requests::answer(&mut *store.lock().await, request);
    match answered {
        Ok((reply, pushes)) => {
            for push in pushes {
                broadcast(everyone, push).await;
            }
            matches!(
                reply,
                maestro_protocol::ServerResponse::ApplyTaskTransitionOk(ref ok) if ok.task.is_some()
            )
        }
        Err(e) => {
            send_diag("warn", format!("[loop] cannot move task {task_id}: {e}"));
            false
        }
    }
}

/// The loop could not go on: failed where it stands, the user's, with the reason.
async fn stop(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    phase: TaskPhase,
    why: &str,
) {
    let guard = TransitionGuard::Phase(phase);
    let note = Some(note_entry(why.to_string()));
    apply(
        store,
        everyone,
        path,
        task_id,
        TaskTransition::PhaseFailed,
        guard,
        note,
    )
    .await;
}

async fn worktree_dir(store: &Store, path: &str, task_id: i32) -> Option<String> {
    crate::task_store::worktrees::list(&*store.lock().await, path, Some(task_id))
        .ok()?
        .into_iter()
        .next()
        .map(|w| crate::worktree::absolute(path, &w.path))
}

/// Remove every sealed path and the hidden files' folder. Whether anything was there.
async fn remove_sealed(dir: &str, sealed: &[String]) -> bool {
    let mut found = false;
    let paths = sealed
        .iter()
        .map(|p| p.trim_end_matches('/'))
        .chain(std::iter::once(SEALED_DIR));
    for relative in paths {
        let target = Path::new(dir).join(relative);
        // Not followed: a link the worker made is removed, never what it points at.
        let Ok(meta) = tokio::fs::symlink_metadata(&target).await else {
            continue;
        };
        found = true;
        let removed = if meta.is_dir() {
            tokio::fs::remove_dir_all(&target).await
        } else {
            tokio::fs::remove_file(&target).await
        };
        if let Err(e) = removed {
            send_diag(
                "warn",
                format!("[loop] cannot remove {}: {e}", target.display()),
            );
        }
    }
    found
}

/// `git add -A` and commit, the repository's hooks included. `None` when there was nothing to
/// commit; the error is git's output, a failing hook's included.
async fn commit(dir: &str, message: &str, limit: Duration) -> Result<Option<Committed>, String> {
    git(dir, &["add", "-A"]).await?;
    if git(dir, &["diff", "--cached", "--name-only"])
        .await?
        .trim()
        .is_empty()
    {
        return Ok(None);
    }
    let mut command = crate::worktree::git_command(dir, &["commit", "-m", message]);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| {
            format!(
                "git commit timed out after {}",
                duration_words(limit.as_secs() as u32)
            )
        })?
        .map_err(|e| format!("cannot run git commit: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string());
    }
    let sha = git(dir, &["rev-parse", "HEAD"]).await?.trim().to_string();
    let stats = git(dir, &["show", "--numstat", "--format=", "HEAD"]).await?;
    Ok(Some(Committed {
        commit_sha: Some(sha),
        ..numstat(&stats)
    }))
}

/// Files, lines added and lines removed. A binary file counts as a file with no lines.
fn numstat(output: &str) -> Committed {
    let mut committed = Committed::default();
    for line in output.lines().filter(|l| !l.trim().is_empty()) {
        let mut columns = line.split('\t');
        let mut count = || {
            columns
                .next()
                .and_then(|c| c.parse::<i32>().ok())
                .unwrap_or(0)
        };
        committed.added += count();
        committed.removed += count();
        committed.files += 1;
    }
    committed
}

/// What one run of the checks found.
#[derive(Debug, Default)]
struct CheckRun {
    /// Every command check, by id.
    results: Vec<(i32, LoopCheckState, Option<String>)>,
    flaky: Vec<String>,
    all_pass: bool,
    /// The failing checks' output, for the next iteration and the stall rule.
    output: String,
}

/// The setup and every command check run in the loop's worktree, where the sealed files simply are,
/// with the hidden files written in for the run.
async fn run_checks(
    dir: &str,
    task: &Task,
    checks: &[LoopCheck],
    hidden: &[LoopHiddenFile],
) -> Result<CheckRun, String> {
    let config = task.loop_config.clone().unwrap_or_default();
    remove_sealed(dir, &[]).await;
    let ran = async {
        write_hidden(dir, hidden).await?;
        Ok::<_, String>(run_commands(dir, &config, checks).await)
    }
    .await;
    remove_sealed(dir, &[]).await;
    ran
}

async fn write_hidden(dir: &str, hidden: &[LoopHiddenFile]) -> Result<(), String> {
    for file in hidden {
        let target = Path::new(dir).join(SEALED_DIR).join(&file.path);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        }
        tokio::fs::write(&target, &file.content)
            .await
            .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
    }
    Ok(())
}

async fn run_commands(dir: &str, config: &LoopConfig, checks: &[LoopCheck]) -> CheckRun {
    let limit = Duration::from_secs(config.check_timeout_secs.into());
    let runnable: Vec<&LoopCheck> = checks.iter().filter(|c| loops::is_runnable(c)).collect();
    let mut run = CheckRun::default();

    if let Some(setup) = config.setup_command.as_deref() {
        let ran = run_shell(dir, setup, limit).await;
        if !ran.passed {
            let detail = format!(
                "The setup command failed, so no check ran.\n{}",
                ran.describe(limit)
            );
            run.results = runnable
                .iter()
                .map(|c| (c.id, LoopCheckState::Fail, Some(detail.clone())))
                .collect();
            run.output = tail_chars(&detail, OUTPUT_CHARS);
            return run;
        }
    }

    let mut failing = Vec::new();
    for check in &runnable {
        let command = check.command.as_deref().unwrap_or_default();
        let first = run_shell(dir, command, limit).await;
        let (state, detail) = if first.passed {
            (LoopCheckState::Pass, first.tail)
        } else if first.timed_out {
            (LoopCheckState::Fail, first.describe(limit))
        } else {
            // The same commit in the same state: a different answer is the check, not the code.
            let second = run_shell(dir, command, limit).await;
            if second.passed {
                run.flaky.push(check.label.clone());
                (
                    LoopCheckState::Flaky,
                    format!("Failed, then passed on the same commit.\n{}", first.tail),
                )
            } else {
                (LoopCheckState::Fail, second.describe(limit))
            }
        };
        if state != LoopCheckState::Pass {
            failing.push(format!("### {}\n{detail}", check.label));
        }
        run.results.push((check.id, state, Some(detail)));
    }
    run.all_pass = failing.is_empty();
    run.output = tail_chars(&failing.join("\n\n"), OUTPUT_CHARS);
    run
}

fn tail_chars(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(limit)).collect()
}

/// How one command went.
#[derive(Debug)]
struct Ran {
    passed: bool,
    timed_out: bool,
    /// The last lines of stdout and stderr, interleaved as they arrived.
    tail: String,
}

impl Ran {
    fn describe(&self, limit: Duration) -> String {
        if self.timed_out {
            let limit = duration_words(limit.as_secs() as u32);
            format!("Timed out after {limit}.\n{}", self.tail)
        } else {
            self.tail.clone()
        }
    }
}

/// The user's shell runs `command` in `dir`. Past `limit` it is killed, with everything it started.
async fn run_shell(dir: &str, command: &str, limit: Duration) -> Ran {
    let failed = |tail: String| Ran {
        passed: false,
        timed_out: false,
        tail,
    };
    let mut shell = shell(command);
    shell
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_console_window();
    let mut child = match shell.spawn() {
        Ok(child) => child,
        Err(e) => return failed(format!("cannot run the command: {e}")),
    };
    let lines = Arc::new(Mutex::new(VecDeque::new()));
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|out| tokio::spawn(collect(out, Arc::clone(&lines)))),
        child
            .stderr
            .take()
            .map(|err| tokio::spawn(collect(err, Arc::clone(&lines)))),
    ]
    .into_iter()
    .flatten()
    .collect();

    let (passed, timed_out) = match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) => (status.success(), false),
        Ok(Err(e)) => {
            lines
                .lock()
                .unwrap()
                .push_back(format!("cannot wait for the command: {e}"));
            (false, false)
        }
        Err(_) => {
            if let Some(pid) = child.id() {
                kill_tree(pid).await;
            }
            let _ = child.kill().await;
            (false, true)
        }
    };
    for reader in readers {
        let abort = reader.abort_handle();
        if tokio::time::timeout(DRAIN_GRACE, reader).await.is_err() {
            abort.abort();
        }
    }
    let tail = lines
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    Ran {
        passed,
        timed_out,
        tail,
    }
}

#[cfg(windows)]
fn shell(command: &str) -> tokio::process::Command {
    // `/S` strips the outer quotes and keeps the rest as typed, which the usual argument quoting
    // would mangle for cmd.
    let mut shell = tokio::process::Command::new("cmd");
    shell
        .args(["/D", "/S", "/C"])
        .raw_arg(format!("\"{command}\""));
    shell
}

#[cfg(not(windows))]
fn shell(command: &str) -> tokio::process::Command {
    let mut shell = tokio::process::Command::new("sh");
    shell.arg("-c").arg(command);
    // Its own process group, so a timeout kills what the command started too.
    shell.process_group(0);
    shell
}

#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let _ = tokio::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_console_window()
        .status()
        .await;
}

#[cfg(not(windows))]
async fn kill_tree(pid: u32) {
    let _ = tokio::process::Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Read `pipe` line by line into `lines`, keeping the last [`TAIL_LINES`].
async fn collect(pipe: impl tokio::io::AsyncRead + Unpin, lines: Arc<Mutex<VecDeque<String>>>) {
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(pipe);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buffer);
                let line: String = line.trim_end().chars().take(LINE_CHARS).collect();
                let mut lines = lines.lock().unwrap();
                lines.push_back(line);
                if lines.len() > TAIL_LINES {
                    lines.pop_front();
                }
            }
        }
    }
}

/// Remove the sandboxes no loop in progress needs: their loop passed, left In Progress, or was
/// deleted. Run on the scheduler's tick, so a sandbox is given back within a minute.
pub(crate) async fn sweep_sandboxes(store: &Store) {
    let read = {
        let conn = store.lock().await;
        let rows = |sql: &str| -> rusqlite::Result<Vec<(String, i32)>> {
            let mut statement = conn.prepare(sql)?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect()
        };
        rows("SELECT DISTINCT project_path, 0 FROM tasks").and_then(|projects| {
            let running = rows(
                "SELECT project_path, id FROM tasks
                 WHERE run_mode = 'Loop' AND status = 'InProgress'",
            )?;
            Ok((projects, running))
        })
    };
    let (projects, running) = match read {
        Ok(found) => found,
        Err(e) => {
            send_diag("warn", format!("[loop] cannot list the loops: {e}"));
            return;
        }
    };
    for (project, _) in projects {
        let root = Path::new(&project).join(".maestro/worktrees");
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(task_id) = name
                .strip_prefix("loop-")
                .and_then(|id| id.parse::<i32>().ok())
            else {
                continue;
            };
            if running.contains(&(project.clone(), task_id)) {
                continue;
            }
            if let Err(e) = crate::worktree::remove_sandbox(&project, task_id).await {
                send_diag(
                    "warn",
                    format!("[loop] cannot remove the sandbox of task {task_id}: {e}"),
                );
            }
        }
    }
}

/// Whether `iteration` has run for `limit` seconds by `now`.
fn overdue(iteration: &LoopIteration, limit: u32, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(&iteration.started_at)
        .is_ok_and(|started| (now - started.to_utc()).num_seconds() >= i64::from(limit))
}

/// Close every Build that has run past its loop's `max_build_secs`, and end its iteration as its
/// turn ending would have: what it wrote is committed and checked, and the loop goes on. Run on
/// the scheduler's tick, so a Build is closed within a minute of its limit, and a restart cannot
/// lose the deadline, which is read from the iteration's start.
pub(crate) async fn sweep_overdue_builds(store: &Store, stdout: &crate::ClientOut) {
    let read = {
        let conn = store.lock().await;
        loops::running_iteration_tasks(&conn)
    };
    let tasks = match read {
        Ok(tasks) => tasks,
        Err(e) => {
            send_diag(
                "warn",
                format!("[loop] cannot list the running iterations: {e}"),
            );
            return;
        }
    };
    for (path, task_id) in tasks {
        let read = {
            let conn = store.lock().await;
            crate::task_store::get(&conn, &path, task_id).and_then(|task| {
                Ok(task.zip(running(&loops::list_iterations(&conn, &path, task_id)?)))
            })
        };
        let Ok(Some((task, iteration))) = read else {
            continue;
        };
        let working = task.phase == Some(TaskPhase::Iterating)
            && matches!(
                task.phase_status,
                Some(PhaseStatus::Running | PhaseStatus::Blocked)
            );
        let limit = task.loop_config.clone().unwrap_or_default().max_build_secs;
        if !working || !overdue(&iteration, limit, chrono::Utc::now()) {
            continue;
        }
        if !claim_end(&path, task_id, &iteration) {
            continue;
        }
        let note = format!(
            "Closed after {}, the limit for one Build, before it finished.",
            duration_words(limit)
        );
        send_diag(
            "info",
            format!("[loop] iteration {} of task {task_id}: {note}", iteration.n),
        );
        for session_id in live_sessions(store, &path, task_id).await {
            close(stdout, &session_id).await;
        }
        let everyone = crate::client_sink::ClientSink::everyone(stdout).await;
        let ended = Ended {
            summary: Some(&note),
            ..Ended::default()
        };
        Box::pin(finish(store, &everyone, &path, &task, &iteration, ended)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        BranchMode, CreateTaskRequest, LoopCheckEntry, LoopCheckKind, LoopCheckSpec, RunMode,
        SetLoopChecksRequest, SetLoopHiddenFilesRequest, WorkspaceMode,
    };

    fn iteration(n: i32, outcome: LoopIterationOutcome, output: Option<&str>) -> LoopIteration {
        LoopIteration {
            n,
            attempt: 1,
            acp_session_id: None,
            agent_id: None,
            started_at: "2026-10-12T10:00:00Z".to_string(),
            ended_at: Some("2026-10-12T10:10:00Z".to_string()),
            outcome,
            counted: true,
            touched_sealed: false,
            commit_sha: None,
            files: 0,
            added: 0,
            removed: 0,
            summary: None,
            check_output: output.map(str::to_string),
            peeks: vec![],
            tokens: None,
            blocked: None,
        }
    }

    fn failing(output: &str) -> CheckRun {
        CheckRun {
            results: vec![(1, LoopCheckState::Fail, Some(output.to_string()))],
            output: output.to_string(),
            ..CheckRun::default()
        }
    }

    #[test]
    fn the_checks_decide_before_the_budget() {
        let config = LoopConfig {
            max_iterations: 1,
            ..LoopConfig::default()
        };
        let one = [iteration(1, LoopIterationOutcome::Checked, Some("x"))];
        let flaky = CheckRun {
            flaky: vec!["Tests pass".to_string()],
            ..CheckRun::default()
        };
        assert_eq!(
            verdict(&config, &one, Some(&flaky), false, None),
            Verdict::Flaky(vec!["Tests pass".to_string()])
        );
        let passed = CheckRun {
            all_pass: true,
            ..CheckRun::default()
        };
        assert_eq!(
            verdict(&config, &one, Some(&passed), false, None),
            Verdict::Passed
        );
        assert_eq!(
            verdict(&config, &one, Some(&failing("x")), false, None),
            Verdict::OutOfIterations
        );
    }

    #[test]
    fn three_failures_in_a_row_stop_the_loop() {
        use LoopIterationOutcome::*;
        let config = LoopConfig::default();
        let mut iterations = vec![
            iteration(1, Failed, None),
            iteration(2, Failed, None),
            iteration(3, Checked, Some("a")),
            iteration(4, Failed, None),
            iteration(5, Failed, None),
        ];
        assert_eq!(
            verdict(&config, &iterations, None, false, None),
            Verdict::Iterate
        );
        iterations.push(iteration(6, Failed, None));
        assert_eq!(
            verdict(&config, &iterations, None, false, None),
            Verdict::Failing
        );
    }

    #[test]
    fn no_progress_is_nothing_committed_or_the_same_failure() {
        use LoopIterationOutcome::*;
        let config = LoopConfig::default();
        let iterations = [
            iteration(1, Checked, Some("3 failed")),
            iteration(2, Checked, Some("2 failed in 1.31s")),
            iteration(3, Empty, None),
        ];
        // Iteration 2 changed the failure; 3 changed nothing.
        assert_eq!(
            verdict(&config, &iterations, Some(&failing("x")), false, None),
            Verdict::Iterate
        );
        let mut stalled = iterations.to_vec();
        stalled.push(iteration(4, Checked, Some("2 failed in 1.31s")));
        stalled.push(iteration(5, Checked, Some("2 failed in 0.98s")));
        // Empty, then the same failure twice, timings aside.
        assert_eq!(
            verdict(&config, &stalled, None, false, None),
            Verdict::Stalled
        );
        assert_eq!(
            verdict(&config, &stalled, None, true, None),
            Verdict::Passed,
            "nothing changed and every check already passes: sign-off, not another iteration"
        );
    }

    #[test]
    fn a_build_is_overdue_at_its_limit_and_ended_once() {
        let build = iteration(1, LoopIterationOutcome::Running, None);
        let at = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().to_utc();
        let started = at(&build.started_at);
        assert!(!overdue(
            &build,
            7200,
            started + chrono::Duration::seconds(7199)
        ));
        assert!(overdue(
            &build,
            7200,
            started + chrono::Duration::seconds(7200)
        ));

        assert!(claim_end("/overdue", 1, &build));
        assert!(
            !claim_end("/overdue", 1, &build),
            "the turn's own end, after the sweep's"
        );
        let again = LoopIteration {
            attempt: build.attempt + 1,
            ..build
        };
        assert!(
            claim_end("/overdue", 1, &again),
            "another attempt is its own"
        );
    }

    #[test]
    fn a_resume_restarts_the_streaks_but_not_the_budget() {
        use LoopIterationOutcome::*;
        let config = LoopConfig {
            max_iterations: 5,
            ..LoopConfig::default()
        };
        let mut iterations = vec![
            iteration(1, Empty, None),
            iteration(2, Empty, None),
            iteration(3, Empty, None),
        ];
        assert_eq!(
            verdict(&config, &iterations, None, false, None),
            Verdict::Stalled
        );
        let mut after = iteration(4, Empty, None);
        after.started_at = "2026-10-12T11:00:00Z".to_string();
        iterations.push(after);
        let resumed = Some("2026-10-12T10:30:00Z");
        assert_eq!(
            verdict(&config, &iterations, None, false, resumed),
            Verdict::Iterate,
            "one empty iteration since the resume"
        );
        let mut last = iteration(5, Empty, None);
        last.started_at = "2026-10-12T11:30:00Z".to_string();
        iterations.push(last);
        assert_eq!(
            verdict(&config, &iterations, None, false, resumed),
            Verdict::OutOfIterations
        );
    }

    #[test]
    fn the_judge_answers_by_number_through_its_decorations() {
        let reply = "Here is my verdict.\n\n**1. PASS**: unknown ids answer 404\n- 3) fail - nothing \
                     handles an empty list\n2. FAILED: `parse` panics on \"\"\n1. FAIL: changed my mind\n\
                     5. PASS: no such check\n\n## Digest\n\n### What changed\nThe handler.";
        let verdicts = judge_verdicts(reply, 4);
        assert_eq!(
            verdicts,
            [
                Some((true, "unknown ids answer 404".to_string())),
                Some((false, "`parse` panics on \"\"".to_string())),
                Some((false, "nothing handles an empty list".to_string())),
                None,
            ]
        );
        assert_eq!(
            digest_of(reply).as_deref(),
            Some("### What changed\nThe handler.")
        );
        assert_eq!(digest_of("1. PASS: fine"), None);
    }

    #[test]
    fn a_peek_is_a_git_command_naming_a_sealed_path() {
        let commands = [
            "git show main:tests/t.rs".to_string(),
            "git status".to_string(),
            "git log -- scripts/check.sh".to_string(),
        ];
        let sealed = ["tests/".to_string(), "scripts/check.sh".to_string()];
        assert_eq!(
            peeks(&commands, &sealed),
            [commands[0].clone(), commands[2].clone()]
        );
    }

    #[test]
    fn numstat_adds_up_and_binary_files_count() {
        let stats = numstat("3\t1\tsrc/a.rs\n-\t-\timg.png\n10\t0\tsrc/b.rs\n");
        assert_eq!((stats.files, stats.added, stats.removed), (3, 13, 1));
    }

    #[cfg(windows)]
    const SLOW: &str = "ping -n 6 127.0.0.1 >NUL";
    #[cfg(not(windows))]
    const SLOW: &str = "sleep 5";

    #[tokio::test]
    async fn a_command_keeps_its_output_and_a_slow_one_is_killed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path().to_str().unwrap();
        let ok = run_shell(dir, "echo one && echo two", Duration::from_secs(30)).await;
        assert!(ok.passed, "{ok:?}");
        assert!(ok.tail.contains("one") && ok.tail.contains("two"), "{ok:?}");

        let bad = run_shell(dir, "exit 3", Duration::from_secs(30)).await;
        assert!(!bad.passed && !bad.timed_out);

        let started = std::time::Instant::now();
        let slow = run_shell(dir, SLOW, Duration::from_secs(1)).await;
        assert!(slow.timed_out && !slow.passed);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    const FAILS_ONCE: &str = "git hash-object flag || (echo x> flag & exit /b 1)";
    #[cfg(not(windows))]
    const FAILS_ONCE: &str = "git hash-object flag || { echo x > flag; exit 1; }";

    #[tokio::test]
    async fn a_check_that_passes_on_its_second_run_is_flaky() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path().to_str().unwrap();
        let check = LoopCheck {
            id: 7,
            position: 0,
            kind: LoopCheckKind::Command,
            label: "Sometimes".to_string(),
            command: Some(FAILS_ONCE.to_string()),
            state: LoopCheckState::Pending,
            detail: None,
            proposed: false,
            accepted: false,
            passed_at_sha: None,
            updated_at: String::new(),
        };
        let run = run_commands(dir, &LoopConfig::default(), &[check]).await;
        assert_eq!(run.flaky, ["Sometimes"]);
        assert_eq!(run.results[0].1, LoopCheckState::Flaky);
        assert!(!run.all_pass);
    }

    async fn git_in(dir: &str, args: &[&str]) {
        git(dir, args).await.expect("git");
    }

    /// A repository with a test the loop seals, and a loop task whose one check runs `check`.
    async fn sealed_loop(check: &str) -> (tempfile::TempDir, Store, Task) {
        let repo = tempfile::tempdir().expect("tempdir");
        // As the daemon keys tasks: by the canonical path.
        let project = crate::automations::canonical_project_path(repo.path().to_str().unwrap());
        git_in(&project, &["init", "-q", "-b", "main"]).await;
        git_in(&project, &["config", "user.name", "t"]).await;
        git_in(&project, &["config", "user.email", "t@t"]).await;
        std::fs::create_dir_all(repo.path().join("tests")).unwrap();
        std::fs::create_dir_all(repo.path().join("src")).unwrap();
        std::fs::write(repo.path().join("tests/t.txt"), "the test").unwrap();
        std::fs::write(repo.path().join("src/a.txt"), "a").unwrap();
        git_in(&project, &["add", "-A"]).await;
        git_in(&project, &["commit", "-q", "-m", "root"]).await;

        let mut conn = crate::project_store::open_in_memory();
        let task = crate::task_store::create(
            &mut conn,
            &CreateTaskRequest {
                project_path: project.clone(),
                title: "Make it pass".to_string(),
                description: None,
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
                run_mode: RunMode::Loop,
                loop_config: Some(LoopConfig {
                    sealed_paths: vec!["tests/".to_string()],
                    ..LoopConfig::default()
                }),
            },
        )
        .unwrap();
        loops::set_checks(
            &mut conn,
            &SetLoopChecksRequest {
                project_path: project.clone(),
                task_id: task.id,
                checks: vec![LoopCheckEntry {
                    id: None,
                    spec: LoopCheckSpec {
                        kind: LoopCheckKind::Command,
                        label: "Sees the sealed files".to_string(),
                        command: Some(check.to_string()),
                    },
                }],
            },
        )
        .unwrap();
        loops::set_hidden_files(
            &mut conn,
            &SetLoopHiddenFilesRequest {
                project_path: project.clone(),
                task_id: task.id,
                files: vec![LoopHiddenFile {
                    path: "h.txt".to_string(),
                    content: "hidden".to_string(),
                }],
            },
        )
        .unwrap();
        (repo, Arc::new(tokio::sync::Mutex::new(conn)), task)
    }

    /// The task as the daemon has it once its first iteration is running in its worktree.
    async fn start(store: &Store, task: &Task) -> (String, Task, LoopIteration) {
        let workspace = crate::worktree::prepare_task_workspace(
            store,
            task,
            maestro_protocol::AgentRole::Worker,
        )
        .await
        .expect("prepare");
        let conn = store.lock().await;
        let path = task.project_path.as_str();
        loops::start_iteration(&conn, path, task.id, 1, "acp-1", "claude").unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'InProgress', phase = 'Iterating', phase_status = 'Running',
                              ball = 'Agent' WHERE id = ?1",
            [task.id],
        )
        .unwrap();
        let task = crate::task_store::get(&conn, path, task.id)
            .unwrap()
            .unwrap();
        let iteration = running(&loops::list_iterations(&conn, path, task.id).unwrap()).unwrap();
        (workspace.cwd, task, iteration)
    }

    const SEES_THEM: &str = "git hash-object tests/t.txt .maestro/loop/sealed/h.txt";

    #[tokio::test]
    async fn an_iteration_is_committed_without_its_sealed_writes_and_checked_with_them() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (dir, task, iteration) = start(&store, &task).await;
        let dir_path = Path::new(&dir);
        assert_eq!(
            dir,
            crate::worktree::sandbox_dir(&task.project_path, task.id)
        );
        assert!(
            !dir_path.join("tests").exists(),
            "the worker never sees the tests"
        );
        let context = worktree_dir(&store, &task.project_path, task.id)
            .await
            .unwrap();
        assert!(Path::new(&context).join("tests/t.txt").exists());

        // The worker's turn: real work, and a try at the tests.
        std::fs::write(dir_path.join("src/b.txt"), "b").unwrap();
        std::fs::create_dir_all(dir_path.join("tests")).unwrap();
        std::fs::write(dir_path.join("tests/t.txt"), "rigged").unwrap();

        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended {
                summary: Some("added b"),
                git_commands: &["git show main:tests/t.txt".to_string()],
                ..Ended::default()
            },
        )
        .await;

        {
            let conn = store.lock().await;
            let task = crate::task_store::get(&conn, &path, task.id)
                .unwrap()
                .unwrap();
            assert_eq!(
                task.phase,
                Some(TaskPhase::Approval),
                "the check saw the sealed files: {:?} {:?}",
                loops::list_iterations(&conn, &path, task.id),
                crate::task_store::list_comments(&conn, &path, task.id)
            );
            let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
            assert_eq!(row.outcome, LoopIterationOutcome::Checked);
            assert!(row.touched_sealed);
            assert_eq!(row.peeks, ["git show main:tests/t.txt"]);
            assert_eq!((row.files, row.summary.as_deref()), (1, Some("added b")));
        }
        let committed = git(&dir, &["show", "--name-only", "--format=", "HEAD"])
            .await
            .unwrap();
        assert_eq!(committed.trim(), "src/b.txt");
        let head = |dir: String| async move { git(&dir, &["rev-parse", "HEAD"]).await.unwrap() };
        assert_eq!(
            head(context.clone()).await,
            head(dir.clone()).await,
            "merged back"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&context).join("tests/t.txt")).unwrap(),
            "the test",
            "the worker's write to a sealed path never reaches the loop's worktree"
        );
        assert!(!dir_path.join("tests").exists());
        assert!(!Path::new(&context).join(SEALED_DIR).exists());
        for dir in [&dir, &context] {
            let status = git(dir, &["status", "--porcelain"]).await.unwrap();
            assert!(status.trim().is_empty(), "nothing left over: {status}");
        }
    }

    #[tokio::test]
    async fn a_commit_the_loops_worktree_cannot_take_halts_the_loop_and_is_merged_later() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (dir, task, iteration) = start(&store, &task).await;
        let context = worktree_dir(&store, &task.project_path, task.id)
            .await
            .unwrap();
        // The user edits the same file in the loop's worktree, uncommitted.
        std::fs::write(Path::new(&dir).join("src/a.txt"), "the worker's").unwrap();
        std::fs::write(Path::new(&context).join("src/a.txt"), "the user's").unwrap();

        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended::default(),
        )
        .await;
        {
            let conn = store.lock().await;
            let halted = crate::task_store::get(&conn, &path, task.id)
                .unwrap()
                .unwrap();
            assert_eq!(halted.ball, maestro_protocol::TaskBall::User);
            let (halt, _) = loops::halt_and_hold(&conn, &path, task.id).unwrap();
            assert_eq!(halt, Some(LoopHalt::Conflict));
        }

        // The user commits theirs; the next iteration's start merges the kept work first.
        git_in(&context, &["commit", "-qam", "the user's"]).await;
        let merged = crate::worktree::prepare_task_workspace(
            &store,
            &task,
            maestro_protocol::AgentRole::Worker,
        )
        .await;
        assert!(merged.is_err(), "the same lines conflict: {merged:?}");
        git_in(&context, &["reset", "-q", "--hard", "HEAD~1"]).await;
        crate::worktree::prepare_task_workspace(&store, &task, maestro_protocol::AgentRole::Worker)
            .await
            .expect("merged once nothing is in the way");
        assert_eq!(
            std::fs::read_to_string(Path::new(&context).join("src/a.txt")).unwrap(),
            "the worker's"
        );
    }

    #[tokio::test]
    async fn a_failing_check_hands_its_output_to_the_next_iteration() {
        let (_repo, store, task) = sealed_loop("git hash-object src/missing.txt").await;
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();

        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended::default(),
        )
        .await;

        let conn = store.lock().await;
        let task = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            (task.phase, task.phase_status, task.ball),
            (
                Some(TaskPhase::Iterating),
                Some(PhaseStatus::Waiting),
                maestro_protocol::TaskBall::Agent
            )
        );
        let check = &loops::list_checks(&conn, &path, task.id).unwrap()[0];
        assert_eq!(check.state, LoopCheckState::Fail);
        // A note the user added while the iteration ran goes to the next one.
        crate::task_store::append(
            &conn,
            &path,
            task.id,
            "steer",
            "user",
            Some("Try the cache first."),
            None,
            None,
        )
        .unwrap();
        let prompt = crate::task_prompt::compose(
            &conn,
            &path,
            &task,
            Some(TaskPhase::Iterating),
            maestro_protocol::AgentRole::Worker,
            None,
            None,
        )
        .unwrap()
        .embed();
        let text = prompt.blocks[1]["text"].as_str().unwrap();
        assert!(text.contains("## Iteration 2"), "{text}");
        assert!(text.contains("Sees the sealed files (failing)"), "{text}");
        assert!(
            text.contains("src/missing.txt"),
            "the output reaches it: {text}"
        );
        assert!(
            text.contains(
                "## Notes from the user

Try the cache first."
            ),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_hook_that_refuses_the_commit_fails_the_iteration_with_its_output() {
        let (repo, store, task) = sealed_loop(SEES_THEM).await;
        let hook = repo.path().join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho lint says no\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();
        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended::default(),
        )
        .await;

        let conn = store.lock().await;
        let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
        assert_eq!(row.outcome, LoopIterationOutcome::Failed);
        assert!(
            row.check_output
                .as_deref()
                .unwrap_or_default()
                .contains("lint says no"),
            "{row:?}"
        );
        let task = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(task.phase_status, Some(PhaseStatus::Waiting), "it goes on");
        let prompt = crate::task_prompt::compose(
            &conn,
            &path,
            &task,
            Some(TaskPhase::Iterating),
            maestro_protocol::AgentRole::Worker,
            None,
            None,
        )
        .unwrap()
        .embed();
        let text = prompt.blocks[1]["text"].as_str().unwrap();
        assert!(text.contains("lint says no"), "{text}");
    }

    fn state(conn: &rusqlite::Connection, task: &Task) -> (Option<TaskPhase>, Option<PhaseStatus>) {
        let task = crate::task_store::get(conn, &task.project_path, task.id)
            .unwrap()
            .unwrap();
        (task.phase, task.phase_status)
    }

    fn judge_says(task: &Task, checks: &[i32], sha: &str, reply: &str) -> LoopEnd {
        LoopEnd {
            project_path: task.project_path.clone(),
            task_id: task.id,
            session: LoopSession::Judge {
                checks: checks.to_vec(),
                sha: sha.to_string(),
            },
            session_id: "judge".to_string(),
            stop_reason: "end_turn".to_string(),
            facts: TurnFacts {
                closing_message: Some(reply.to_string()),
                ..TurnFacts::default()
            },
            limited_until: None,
        }
    }

    #[tokio::test]
    async fn the_judge_decides_once_the_commands_pass_and_its_digest_goes_to_sign_off() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let path = task.project_path.clone();
        loops::set_checks(
            &mut *store.lock().await,
            &SetLoopChecksRequest {
                project_path: path.clone(),
                task_id: task.id,
                checks: [
                    (
                        LoopCheckKind::Command,
                        "Sees the sealed files",
                        Some(SEES_THEM),
                    ),
                    (LoopCheckKind::Judge, "Names say what they hold", None),
                ]
                .into_iter()
                .map(|(kind, label, command)| LoopCheckEntry {
                    id: None,
                    spec: LoopCheckSpec {
                        kind,
                        label: label.to_string(),
                        command: command.map(str::to_string),
                    },
                })
                .collect(),
            },
        )
        .unwrap();
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();
        let everyone = crate::client_sink::ClientSink::detached();
        let ended = Ended {
            git_commands: &["git show main:tests/t.txt".to_string()],
            ..Ended::default()
        };
        finish(&store, &everyone, &path, &task, &iteration, ended).await;

        let (checks, sha) = {
            let conn = store.lock().await;
            assert_eq!(
                state(&conn, &task),
                (Some(TaskPhase::Judging), Some(PhaseStatus::Waiting))
            );
            let task = crate::task_store::get(&conn, &path, task.id)
                .unwrap()
                .unwrap();
            assert_eq!(
                crate::task_turn::next_stage(&task),
                Some(maestro_protocol::AgentRole::Judge)
            );
            let prompt = crate::task_prompt::compose(
                &conn,
                &path,
                &task,
                Some(TaskPhase::Judging),
                maestro_protocol::AgentRole::Judge,
                None,
                Some(" src/b.txt | 1 +"),
            )
            .unwrap()
            .embed();
            let text = prompt.blocks[1]["text"].as_str().unwrap();
            assert!(text.contains("`git diff main...HEAD`"), "{text}");
            assert!(text.contains("src/b.txt | 1 +"), "{text}");
            assert!(text.contains("1. Names say what they hold"), "{text}");
            let (checks, sha) = loops::to_judge(&conn, &path, task.id).unwrap();
            let ids: Vec<i32> = checks.iter().map(|c| c.id).collect();
            (ids, sha.unwrap())
        };
        let judging = "UPDATE tasks SET phase = 'Judging', phase_status = 'Running' WHERE id = ?1";

        store.lock().await.execute(judging, [task.id]).unwrap();
        let fail = judge_says(
            &task,
            &checks,
            &sha,
            "1. FAIL: `b.txt` holds a letter, not a name",
        );
        judge_ended(&store, &everyone, &everyone, &path, &checks, &sha, fail).await;
        {
            let conn = store.lock().await;
            assert_eq!(
                state(&conn, &task),
                (Some(TaskPhase::Iterating), Some(PhaseStatus::Waiting))
            );
            let task = crate::task_store::get(&conn, &path, task.id)
                .unwrap()
                .unwrap();
            let prompt = crate::task_prompt::compose(
                &conn,
                &path,
                &task,
                Some(TaskPhase::Iterating),
                maestro_protocol::AgentRole::Worker,
                None,
                None,
            )
            .unwrap()
            .embed();
            let text = prompt.blocks[1]["text"].as_str().unwrap();
            assert!(
                text.contains("Names say what they hold (the judge failed it)"),
                "{text}"
            );
            assert!(text.contains("holds a letter, not a name"), "{text}");
        }

        store.lock().await.execute(judging, [task.id]).unwrap();
        let pass = judge_says(
            &task,
            &checks,
            &sha,
            "1. PASS: clear enough\n\n## Digest\n\n### What changed\nAdded b.",
        );
        judge_ended(&store, &everyone, &everyone, &path, &checks, &sha, pass).await;
        let conn = store.lock().await;
        assert_eq!(
            state(&conn, &task),
            (Some(TaskPhase::Approval), Some(PhaseStatus::Waiting))
        );
        let check = &loops::list_checks(&conn, &path, task.id).unwrap()[1];
        assert_eq!(check.passed_at_sha.as_deref(), Some(sha.as_str()));
        let digest = crate::task_store::latest_of_kind(&conn, &path, task.id, "digest")
            .unwrap()
            .and_then(|c| c.body)
            .unwrap();
        assert!(digest.starts_with("### What changed\nAdded b."), "{digest}");
        assert!(
            digest.contains("Iteration 1 ran `git show main:tests/t.txt`."),
            "the peek is worth a look: {digest}"
        );
    }

    #[tokio::test]
    async fn a_restarted_loop_loses_its_work_and_its_history() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();
        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        let ended = Ended {
            summary: Some("added b"),
            ..Ended::default()
        };
        finish(&store, &everyone, &path, &task, &iteration, ended).await;
        let context = worktree_dir(&store, &path, task.id).await.unwrap();
        assert!(
            Path::new(&context).join("src/b.txt").exists(),
            "merged back"
        );

        let running = TaskRef {
            project_path: path.clone(),
            task_id: task.id,
        };
        store
            .lock()
            .await
            .execute(
                "UPDATE tasks SET phase = 'Iterating', phase_status = 'Running' WHERE id = ?1",
                [task.id],
            )
            .unwrap();
        let restart = |status| maestro_protocol::RestartLoopRequest {
            project_path: running.project_path.clone(),
            task_id: running.task_id,
            status,
        };
        assert!(
            restart_loop(&store, restart(maestro_protocol::TaskStatus::Queue))
                .await
                .is_err(),
            "not while it runs"
        );
        store
            .lock()
            .await
            .execute(
                "UPDATE tasks SET status = 'Review', phase = 'Approval', phase_status = 'Waiting',
                                  ball = 'User', loop_halt = 'Stalled' WHERE id = ?1",
                [task.id],
            )
            .unwrap();
        restart_loop(&store, restart(maestro_protocol::TaskStatus::Queue))
            .await
            .unwrap();

        let head = git(&context, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(Some(head.trim()), task.execution_start_sha.as_deref());
        assert!(!Path::new(&context).join("src/b.txt").exists());
        assert!(!Path::new(&dir).exists(), "the sandbox goes");
        let conn = store.lock().await;
        assert!(loops::list_iterations(&conn, &path, task.id)
            .unwrap()
            .is_empty());
        let checks = loops::list_checks(&conn, &path, task.id).unwrap();
        assert!(checks.iter().all(|c| c.state == LoopCheckState::Pending));
        let task = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(task.status, maestro_protocol::TaskStatus::Queue);
        assert_eq!(task.phase, None);
        assert_eq!(
            loops::halt_and_hold(&conn, &path, task.id).unwrap(),
            (None, None)
        );
    }

    #[tokio::test]
    async fn a_sandbox_goes_once_its_loop_is_no_longer_in_progress() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (dir, task, _) = start(&store, &task).await;
        sweep_sandboxes(&store).await;
        assert!(Path::new(&dir).exists(), "kept while the loop runs");
        store
            .lock()
            .await
            .execute(
                "UPDATE tasks SET status = 'Review' WHERE id = ?1",
                [task.id],
            )
            .unwrap();
        sweep_sandboxes(&store).await;
        assert!(!Path::new(&dir).exists());
        let listed = git(&task.project_path, &["worktree", "list"])
            .await
            .unwrap();
        assert!(!listed.contains("loop-"), "{listed}");
    }

    #[tokio::test]
    async fn a_loops_preparer_works_in_the_loops_worktree_with_the_tests() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let workspace = crate::worktree::prepare_task_workspace(
            &store,
            &task,
            maestro_protocol::AgentRole::Preparer,
        )
        .await
        .unwrap();
        assert_eq!(
            Some(workspace.cwd.clone()),
            worktree_dir(&store, &task.project_path, task.id).await
        );
        assert!(Path::new(&workspace.cwd).join("tests/t.txt").exists());
    }

    #[tokio::test]
    async fn accepting_a_proposal_seals_only_what_the_loops_branch_has() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let path = task.project_path.clone();
        let proposal = {
            let conn = store.lock().await;
            conn.execute(
                "INSERT INTO loop_checks (project_path, task_id, position, kind, label, proposed,
                                          updated_at)
                 VALUES (?1, ?2, 9, 'Command', 'Empty lists', 1, '')",
                rusqlite::params![path, task.id],
            )
            .unwrap();
            conn.last_insert_rowid() as i32
        };
        let ask = |seal: &[&str]| {
            ServerRequest::AnswerLoopProposal(maestro_protocol::AnswerLoopProposalRequest {
                project_path: path.clone(),
                task_id: task.id,
                check_id: proposal,
                accept: Some(LoopCheckSpec {
                    kind: LoopCheckKind::Command,
                    label: "Empty lists".to_string(),
                    command: Some("git hash-object src/a.txt".to_string()),
                }),
                seal: seal.iter().map(|s| s.to_string()).collect(),
            })
        };
        let stdout = crate::client_sink::ClientSink::detached();
        let (refused, _) = answer(ask(&["nowhere/"]), Some(&store), &stdout).await;
        assert!(
            matches!(&refused, ServerResponse::Error(e) if e.message.contains("not committed on main")),
            "{refused:?}"
        );
        let (accepted, pushes) = answer(ask(&["src/a.txt"]), Some(&store), &stdout).await;
        assert!(
            matches!(accepted, ServerResponse::AnswerLoopProposalOk(_)),
            "{accepted:?}"
        );
        assert!(!pushes.is_empty());
        let conn = store.lock().await;
        let task = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            task.loop_config.unwrap().sealed_paths,
            ["tests/", "src/a.txt"]
        );
    }

    #[tokio::test]
    async fn an_iteration_with_nothing_to_commit_runs_no_checks() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (_dir, task, iteration) = start(&store, &task).await;
        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended::default(),
        )
        .await;

        let conn = store.lock().await;
        let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
        assert_eq!(row.outcome, LoopIterationOutcome::Empty);
        let check = &loops::list_checks(&conn, &path, task.id).unwrap()[0];
        assert_eq!(check.state, LoopCheckState::Pending);
    }

    #[tokio::test]
    async fn a_usage_limit_keeps_the_work_and_runs_the_iteration_again_uncounted() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let path = task.project_path.clone();
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "half").unwrap();
        let everyone = crate::client_sink::ClientSink::detached();
        let until = chrono::Utc::now() + chrono::Duration::hours(2);
        let ended = Ended {
            agent_failed: true,
            cut: Some(Cut::Limit(until)),
            ..Ended::default()
        };
        finish(&store, &everyone, &path, &task, &iteration, ended).await;

        {
            let conn = store.lock().await;
            assert_eq!(
                state(&conn, &task),
                (Some(TaskPhase::Iterating), Some(PhaseStatus::Waiting))
            );
            let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
            assert_eq!(row.outcome, LoopIterationOutcome::Interrupted);
            assert!(!row.counted);
            assert!(row.commit_sha.is_some(), "the cut-off work is committed");
            assert_eq!(loops::next_iteration(&conn, &path, task.id).unwrap(), 1);
            loops::start_iteration(&conn, &path, task.id, 1, "acp-2", "claude").unwrap();
            let again = running(&loops::list_iterations(&conn, &path, task.id).unwrap()).unwrap();
            assert_eq!((again.n, again.attempt), (1, 2));
            let thread = crate::task_store::list_comments(&conn, &path, task.id).unwrap();
            let note = thread
                .last()
                .and_then(|c| c.body.as_deref())
                .unwrap_or_default();
            assert!(note.contains("usage limit"), "{note}");
        }
        let log = git(&dir, &["log", "-1", "--format=%s"]).await.unwrap();
        assert_eq!(log.trim(), "loop: iteration 1, cut off (WIP)");

        // A judge cut off judges again: nothing is recorded against its checks.
        let judging = "UPDATE tasks SET phase = 'Judging', phase_status = 'Running' WHERE id = ?1";
        store.lock().await.execute(judging, [task.id]).unwrap();
        let mut refused = judge_says(&task, &[], "sha", "");
        refused.stop_reason = "error".to_string();
        refused.limited_until = Some(until);
        judge_ended(&store, &everyone, &everyone, &path, &[], "sha", refused).await;
        assert_eq!(
            state(&*store.lock().await, &task),
            (Some(TaskPhase::Judging), Some(PhaseStatus::Waiting))
        );
    }

    #[tokio::test]
    async fn a_blocked_worker_halts_the_loop_with_its_work_committed_and_unchecked() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let path = task.project_path.clone();
        let (dir, task, _) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "so far").unwrap();
        let everyone = crate::client_sink::ClientSink::detached();
        let iteration = {
            let conn = store.lock().await;
            assert!(loops::set_blocked(&conn, &path, task.id, 1, "Which API key?").unwrap());
            running(&loops::list_iterations(&conn, &path, task.id).unwrap()).unwrap()
        };
        // Refused for a usage limit after the call: the worker had already said it is blocked.
        let until = chrono::Utc::now() + chrono::Duration::hours(2);
        let ended = Ended {
            cut: Some(Cut::Limit(until)),
            ..Ended::default()
        };
        finish(&store, &everyone, &path, &task, &iteration, ended).await;

        let conn = store.lock().await;
        let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
        assert_eq!(row.outcome, LoopIterationOutcome::Blocked);
        assert!(row.counted);
        let check = &loops::list_checks(&conn, &path, task.id).unwrap()[0];
        assert_eq!(
            check.state,
            LoopCheckState::Pending,
            "the checks did not run"
        );
        assert_eq!(
            loops::halt_and_hold(&conn, &path, task.id).unwrap(),
            (Some(LoopHalt::Blocked), None)
        );
        let stored = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.ball, TaskBall::User);
        let thread = crate::task_store::list_comments(&conn, &path, task.id).unwrap();
        let note = thread
            .last()
            .and_then(|c| c.body.as_deref())
            .unwrap_or_default();
        assert!(note.contains("Which API key?"), "{note}");
        // The next iteration is told what the user's answer is about.
        let prompt = crate::task_prompt::compose(
            &conn,
            &path,
            &stored,
            Some(TaskPhase::Iterating),
            maestro_protocol::AgentRole::Worker,
            None,
            None,
        )
        .unwrap()
        .embed();
        let text = prompt.blocks[1]["text"].as_str().unwrap();
        assert!(
            text.contains("## The last iteration was blocked") && text.contains("Which API key?"),
            "{text}"
        );
        drop(conn);
        let log = git(&dir, &["log", "-1", "--format=%s"]).await.unwrap();
        assert_eq!(log.trim(), "loop: iteration 1");
    }

    #[tokio::test]
    async fn a_pause_waits_for_the_checks_and_a_stop_cuts_the_iteration() {
        let (_repo, store, task) = sealed_loop("git rev-parse --verify --quiet no-such-ref").await;
        let path = task.project_path.clone();
        let everyone = crate::client_sink::ClientSink::detached();
        let (dir, task, iteration) = start(&store, &task).await;
        let task_ref = |task: &Task| TaskRef {
            project_path: path.clone(),
            task_id: task.id,
        };
        let summary = |conn: &rusqlite::Connection| {
            crate::task_store::get(conn, &path, task.id)
                .unwrap()
                .unwrap()
                .loop_summary
                .unwrap()
        };

        // Paused while it runs: the iteration ends and its checks run, then it holds.
        let pushes = hold_loop(&store, &everyone, task_ref(&task), LoopHalt::Paused)
            .await
            .unwrap();
        assert_eq!(pushes.len(), 1);
        assert_eq!(summary(&*store.lock().await).hold, Some(LoopHalt::Paused));
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();
        finish(
            &store,
            &everyone,
            &path,
            &task,
            &iteration,
            Ended::default(),
        )
        .await;
        {
            let conn = store.lock().await;
            let held = crate::task_store::get(&conn, &path, task.id)
                .unwrap()
                .unwrap();
            assert_eq!(
                (held.phase, held.phase_status, held.ball),
                (
                    Some(TaskPhase::Iterating),
                    Some(PhaseStatus::Waiting),
                    TaskBall::User
                )
            );
            let summary = held.loop_summary.unwrap();
            assert_eq!((summary.halt, summary.hold), (Some(LoopHalt::Paused), None));
            assert_eq!((summary.iteration, summary.counted), (1, 1));
            assert_eq!(summary.checks, [LoopCheckState::Fail]);
        }
        assert!(
            hold_loop(&store, &everyone, task_ref(&task), LoopHalt::Stopped)
                .await
                .is_err(),
            "a held loop is not running"
        );

        // Stopped while the next iteration runs: cut now, its work kept and not counted.
        {
            let conn = store.lock().await;
            loops::start_iteration(&conn, &path, task.id, 2, "acp-2", "claude").unwrap();
            conn.execute(
                "UPDATE tasks SET phase_status = 'Running', ball = 'Agent' WHERE id = ?1",
                [task.id],
            )
            .unwrap();
        }
        std::fs::write(Path::new(&dir).join("src/c.txt"), "half").unwrap();
        hold_loop(&store, &everyone, task_ref(&task), LoopHalt::Stopped)
            .await
            .unwrap();
        // The cut work is committed off the loop, after the answer.
        for _ in 0..200 {
            let rows = loops::list_iterations(&*store.lock().await, &path, task.id).unwrap();
            if rows[1].outcome == LoopIterationOutcome::Interrupted {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let conn = store.lock().await;
        let stopped = crate::task_store::get(&conn, &path, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            (stopped.phase_status, stopped.ball),
            (Some(PhaseStatus::Waiting), TaskBall::User)
        );
        let summary = stopped.loop_summary.unwrap();
        assert_eq!(
            (summary.halt, summary.counted),
            (Some(LoopHalt::Stopped), 1)
        );
        let rows = loops::list_iterations(&conn, &path, task.id).unwrap();
        assert_eq!(rows[1].outcome, LoopIterationOutcome::Interrupted);
        assert!(rows[1].commit_sha.is_some());
    }

    #[tokio::test]
    async fn an_iteration_reads_its_tokens_from_the_usage_record() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let path = task.project_path.clone();
        let (_dir, task, _) = start(&store, &task).await;
        let conn = store.lock().await;
        conn.execute(
            "INSERT INTO usage_turns (agent_id, acp_session_id, project_path, started_at, ended_at,
                                      stop_reason, total_tokens)
             VALUES ('claude', 'acp-1', ?1, 'now', 'now', 'end_turn', 1200),
                    ('claude', 'acp-1', ?1, 'now', 'now', 'end_turn', 300)",
            [&path],
        )
        .unwrap();
        let rows = loops::list_iterations(&conn, &path, task.id).unwrap();
        assert_eq!(rows[0].tokens, Some(1500));
    }
}
