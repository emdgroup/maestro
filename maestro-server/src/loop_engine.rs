//! A loop task between two iterations: the worker's session closed, its work committed, the sealed
//! checks run with no session live, and the next step decided. See `docs/loops-plan.md`, phase 1.
//!
//! Everything here runs off the main loop. The one thing the loop has to do, closing the iteration's
//! session, goes to it through `Settle::LoopSessionClose`, and the engine waits for the close
//! before any sealed file reaches the disk.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use maestro_protocol::{
    ApplyTaskTransitionRequest, LoopCheck, LoopCheckState, LoopConfig, LoopHiddenFile,
    LoopIteration, LoopIterationOutcome, NewTaskComment, PhaseStatus, ServerRequest, Task,
    TaskPhase, TaskTransition, TransitionGuard,
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

/// The iteration a loop session was started for, from its role meta.
pub(crate) fn iteration_of(session: &crate::sessions::ActiveSession) -> Option<i32> {
    let role = session.project.as_ref()?.meta.role.as_deref()?;
    let value: serde_json::Value = serde_json::from_str(role).ok()?;
    value.get("iteration")?.as_i64().map(|n| n as i32)
}

/// A loop session's turn ended.
pub(crate) struct IterationEnd {
    pub project_path: String,
    pub task_id: i32,
    pub iteration: i32,
    pub session_id: String,
    pub stop_reason: String,
    pub facts: TurnFacts,
}

/// Finish the iteration off the loop. What follows is the drain's to start.
pub(crate) fn spawn(store: Store, stdout: crate::ClientOut, end: IterationEnd) {
    tokio::spawn(Box::pin(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
        let path = crate::automations::canonical_project_path(&end.project_path);
        Box::pin(iteration_ended(&store, &stdout, &everyone, &path, end)).await;
        crate::scheduler::request_drain(&path);
    }));
}

async fn iteration_ended(
    store: &Store,
    stdout: &crate::ClientOut,
    everyone: &crate::ClientOut,
    path: &str,
    end: IterationEnd,
) {
    // The pipeline's rule: a turn the user stopped, or one cut short, ends nothing.
    if end.facts.user_interrupted || matches!(end.stop_reason.as_str(), "cancelled" | "auth_required")
    {
        return;
    }
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
    if !working || iteration.n != end.iteration {
        send_diag(
            "debug",
            format!(
                "[loop] ignoring the end of iteration {} of task {}, not the one running",
                end.iteration, end.task_id
            ),
        );
        return;
    }
    close(stdout, &end.session_id).await;
    let failed = end.stop_reason != "end_turn";
    finish(
        store,
        everyone,
        path,
        &task,
        &iteration,
        end.facts.closing_message.as_deref(),
        failed,
    )
    .await;
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
async fn close(stdout: &crate::ClientOut, session_id: &str) {
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
pub(crate) async fn finish_orphan(store: &Store, everyone: &crate::ClientOut, path: &str, task_id: i32) {
    let read = {
        let conn = store.lock().await;
        crate::task_store::get(&conn, path, task_id).and_then(|task| {
            Ok(task.zip(running(&loops::list_iterations(&conn, path, task_id)?)))
        })
    };
    match read {
        Ok(Some((task, iteration))) => {
            finish(store, everyone, path, &task, &iteration, None, false).await
        }
        Ok(None) => {}
        Err(e) => send_diag("warn", format!("[loop] task {task_id} at startup: {e}")),
    }
}

/// Discard what the worker wrote where it may not, commit the rest, and check it.
async fn finish(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task: &Task,
    iteration: &LoopIteration,
    summary: Option<&str>,
    agent_failed: bool,
) {
    let task_id = task.id;
    let Some(dir) = worktree_dir(store, path, task_id).await else {
        stop(store, everyone, path, task_id, TaskPhase::Iterating, "The loop's worktree is gone.")
            .await;
        return;
    };
    let config = task.loop_config.clone().unwrap_or_default();
    // Removed before the sparse checkout is set again, which then marks them cleanly: set first,
    // and a sealed file the worker changed would stay, and its removal be staged.
    let touched_sealed = remove_sealed(&dir, &config.sealed_paths).await;
    let resealed = crate::worktree::seal(&dir, task).await;
    let committed = match resealed {
        Ok(()) => commit(&dir, iteration.n, Duration::from_secs(config.check_timeout_secs.into())).await,
        Err(e) => Err(e),
    };
    let row = Committed {
        touched_sealed,
        ..committed.clone().ok().flatten().unwrap_or_default()
    };
    if let Err(e) = loops::record_commit(&*store.lock().await, path, task_id, iteration, summary, &row) {
        send_diag("warn", format!("[loop] task {task_id}: {e}"));
    }
    if touched_sealed {
        send_diag(
            "info",
            format!("[loop] iteration {} of task {task_id} wrote at a sealed path", iteration.n),
        );
    }

    let (outcome, output) = match committed {
        _ if agent_failed => (LoopIterationOutcome::Failed, None),
        Err(e) => (
            LoopIterationOutcome::Failed,
            Some(format!("The iteration's commit failed:\n{}", tail_chars(&e, OUTPUT_CHARS))),
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
    if let Err(e) =
        loops::record_outcome(&*store.lock().await, path, task_id, iteration, outcome, output.as_deref())
    {
        send_diag("warn", format!("[loop] task {task_id}: {e}"));
    }
    conclude(store, everyone, path, task_id, TaskPhase::Iterating, None).await;
}

/// After a restart: checks that died with the daemon run again.
pub(crate) async fn recheck(store: &Store, everyone: &crate::ClientOut, path: &str, task_id: i32) {
    Box::pin(check(store, everyone, path, task_id)).await;
}

/// The user's Re-run checks, once the task is `Checking`: a new snapshot of the base, then the
/// checks on the commit the loop is at.
pub(crate) fn rerun(store: Store, stdout: crate::ClientOut, path: String, task_id: i32) {
    tokio::spawn(Box::pin(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
        let task = crate::task_store::get(&*store.lock().await, &path, task_id);
        if let Ok(Some(task)) = task {
            let base = match task.base_branch.trim() {
                "" => "HEAD",
                base => base,
            };
            match git(&path, &["rev-parse", "--verify", base]).await {
                Ok(sha) => {
                    if let Err(e) =
                        loops::set_sealed_sha(&*store.lock().await, &path, task_id, sha.trim())
                    {
                        send_diag("warn", format!("[loop] task {task_id}: {e}"));
                    }
                }
                Err(e) => {
                    let note = format!("The checks could not run: the base branch is unreadable. {e}");
                    stop(&store, &everyone, &path, task_id, TaskPhase::Checking, &note).await;
                    return;
                }
            }
        }
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
        stop(store, everyone, path, task_id, TaskPhase::Checking, "The loop's worktree is gone.")
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
        let recorded = loops::record_results(&mut conn, path, task_id, &run.results).and_then(|()| {
            match &last {
                Some(last) => loops::record_outcome(
                    &conn,
                    path,
                    task_id,
                    last,
                    LoopIterationOutcome::Checked,
                    Some(&run.output).filter(|o| !o.is_empty()).map(String::as_str),
                ),
                None => Ok(()),
            }
        });
        if let Err(e) = recorded {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
        }
    }
    conclude(store, everyone, path, task_id, TaskPhase::Checking, Some(&run)).await;
}

/// Where the loop stands once an iteration is recorded, and the transition that says so.
async fn conclude(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    phase: TaskPhase,
    run: Option<&CheckRun>,
) {
    let read = {
        let conn = store.lock().await;
        crate::task_store::get(&conn, path, task_id).and_then(|task| {
            Ok(task.map(|t| (t, loops::list_iterations(&conn, path, task_id))))
        })
    };
    let (task, iterations) = match read {
        Ok(Some((task, Ok(iterations)))) => (task, iterations),
        Ok(None) => return,
        Ok(Some((_, Err(e)))) | Err(e) => {
            send_diag("warn", format!("[loop] task {task_id}: {e}"));
            return;
        }
    };
    let config = task.loop_config.clone().unwrap_or_default();
    let verdict = verdict(&config, &iterations, run);
    let n = iterations.last().map_or(0, |i| i.n);
    let (event, note) = match &verdict {
        Verdict::Flaky(labels) => (
            TaskTransition::PhaseFailed,
            format!(
                "Paused after iteration {n}: {} gave a different result when run again on the same \
                 commit, so it is flaky. Fix it or remove it, then re-run the checks.",
                labels.join(", ")
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
            format!("Stopped: the loop used its {} iterations.", config.max_iterations),
        ),
        Verdict::OutOfTime => (
            TaskTransition::LoopHalted,
            format!(
                "Stopped: the loop used its {} of agent time.",
                duration_words(config.max_agent_secs)
            ),
        ),
        Verdict::Iterate => (TaskTransition::LoopIterate, progress_note(n, &iterations, run)),
    };
    apply(
        store,
        everyone,
        path,
        task_id,
        event,
        TransitionGuard::Phase(phase),
        Some(note),
    )
    .await;
}

fn progress_note(n: i32, iterations: &[LoopIteration], run: Option<&CheckRun>) -> String {
    let last = iterations.last();
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
    OutOfTime,
    Iterate,
}

/// What the loop does next, from its iterations, oldest first, and the checks just run.
fn verdict(config: &LoopConfig, iterations: &[LoopIteration], run: Option<&CheckRun>) -> Verdict {
    if let Some(run) = run {
        if !run.flaky.is_empty() {
            return Verdict::Flaky(run.flaky.clone());
        }
        if run.all_pass {
            return Verdict::Passed;
        }
    }
    let ended: Vec<&LoopIteration> = iterations
        .iter()
        .filter(|i| {
            !matches!(
                i.outcome,
                LoopIterationOutcome::Running | LoopIterationOutcome::Interrupted
            )
        })
        .collect();
    let failing = ended
        .iter()
        .rev()
        .take_while(|i| i.outcome == LoopIterationOutcome::Failed)
        .count();
    if failing >= FAILURES_IN_A_ROW {
        return Verdict::Failing;
    }
    let stalled = (0..ended.len())
        .rev()
        .take_while(|&k| {
            // Measured against the last iteration that was checked: an empty one in between
            // changed nothing to compare.
            let checked = ended[..k]
                .iter()
                .rev()
                .find(|i| i.outcome == LoopIterationOutcome::Checked);
            no_progress(checked.copied(), ended[k])
        })
        .count();
    if stalled >= config.stall_limit as usize {
        return Verdict::Stalled;
    }
    let counted: Vec<&&LoopIteration> = ended.iter().filter(|i| i.counted).collect();
    if counted.len() >= config.max_iterations as usize {
        return Verdict::OutOfIterations;
    }
    let seconds: i64 = counted.iter().map(|i| agent_seconds(i)).sum();
    if seconds >= i64::from(config.max_agent_secs) {
        return Verdict::OutOfTime;
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
    let strip = |s: &str| s.chars().filter(|c| !c.is_ascii_digit()).collect::<String>();
    match (a, b) {
        (Some(a), Some(b)) => strip(a) == strip(b),
        _ => false,
    }
}

fn agent_seconds(iteration: &LoopIteration) -> i64 {
    let at = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (at(&iteration.started_at), iteration.ended_at.as_deref().and_then(at)) {
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

/// One guarded transition with a note in the thread, pushed. Whether it applied.
async fn apply(
    store: &Store,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    note: Option<String>,
) -> bool {
    let request = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: path.to_string(),
        task_id,
        event,
        guard,
        update: None,
        comment: note.map(|body| NewTaskComment {
            kind: "note".to_string(),
            author: "maestro".to_string(),
            body: Some(body),
            external_ref: None,
            phase: None,
        }),
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
    let note = Some(why.to_string());
    apply(store, everyone, path, task_id, TaskTransition::PhaseFailed, guard, note).await;
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
            send_diag("warn", format!("[loop] cannot remove {}: {e}", target.display()));
        }
    }
    found
}

/// `git add -A` and commit, the repository's hooks included. `None` when there was nothing to
/// commit; the error is git's output, a failing hook's included.
async fn commit(dir: &str, n: i32, limit: Duration) -> Result<Option<Committed>, String> {
    git(dir, &["add", "-A"]).await?;
    if git(dir, &["diff", "--cached", "--name-only"]).await?.trim().is_empty() {
        return Ok(None);
    }
    let message = format!("loop: iteration {n}");
    let mut command = crate::worktree::git_command(dir, &["commit", "-m", &message]);
    command.kill_on_drop(true).stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| format!("git commit timed out after {}", duration_words(limit.as_secs() as u32)))?
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
        let mut count = || columns.next().and_then(|c| c.parse::<i32>().ok()).unwrap_or(0);
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

/// The sealed files in, the setup and every command check run, the sealed files out again.
async fn run_checks(
    dir: &str,
    task: &Task,
    checks: &[LoopCheck],
    hidden: &[LoopHiddenFile],
) -> Result<CheckRun, String> {
    let config = task.loop_config.clone().unwrap_or_default();
    let sha = task
        .loop_sealed_sha
        .as_deref()
        .ok_or("the loop has no sealed snapshot yet")?;
    remove_sealed(dir, &config.sealed_paths).await;
    let ran = async {
        write_sealed(dir, sha, &config.sealed_paths).await?;
        write_hidden(dir, hidden).await?;
        Ok::<_, String>(run_commands(dir, &config, checks).await)
    }
    .await;
    remove_sealed(dir, &config.sealed_paths).await;
    ran
}

/// The sealed paths as the snapshot has them, written to the worktree only: the index keeps the
/// branch's, so nothing here is ever committed. A path the snapshot lacks is skipped.
async fn write_sealed(dir: &str, sha: &str, sealed: &[String]) -> Result<(), String> {
    let wanted: Vec<&str> = sealed.iter().map(|p| p.trim_end_matches('/')).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut args = vec!["ls-tree", "-z", "--name-only", sha, "--"];
    args.extend(&wanted);
    let listed = git(dir, &args).await?;
    let present: Vec<&str> = listed.split('\0').filter(|p| !p.is_empty()).collect();
    if present.is_empty() {
        return Ok(());
    }
    let source = format!("--source={sha}");
    let mut args = vec![
        "restore",
        source.as_str(),
        "--worktree",
        "--ignore-skip-worktree-bits",
        "--",
    ];
    args.extend(&present);
    git(dir, &args).await.map(|_| ())
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
            let detail = format!("The setup command failed, so no check ran.\n{}", ran.describe(limit));
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
            lines.lock().unwrap().push_back(format!("cannot wait for the command: {e}"));
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
    let tail = lines.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
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
    shell.args(["/D", "/S", "/C"]).raw_arg(format!("\"{command}\""));
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
async fn collect(
    pipe: impl tokio::io::AsyncRead + Unpin,
    lines: Arc<Mutex<VecDeque<String>>>,
) {
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
            verdict(&config, &one, Some(&flaky)),
            Verdict::Flaky(vec!["Tests pass".to_string()])
        );
        let passed = CheckRun {
            all_pass: true,
            ..CheckRun::default()
        };
        assert_eq!(verdict(&config, &one, Some(&passed)), Verdict::Passed);
        assert_eq!(
            verdict(&config, &one, Some(&failing("x"))),
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
        assert_eq!(verdict(&config, &iterations, None), Verdict::Iterate);
        iterations.push(iteration(6, Failed, None));
        assert_eq!(verdict(&config, &iterations, None), Verdict::Failing);
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
            verdict(&config, &iterations, Some(&failing("x"))),
            Verdict::Iterate
        );
        let mut stalled = iterations.to_vec();
        stalled.push(iteration(4, Checked, Some("2 failed in 1.31s")));
        stalled.push(iteration(5, Checked, Some("2 failed in 0.98s")));
        // Empty, then the same failure twice, timings aside.
        assert_eq!(verdict(&config, &stalled, None), Verdict::Stalled);
    }

    #[test]
    fn agent_time_counts_only_counted_iterations() {
        use LoopIterationOutcome::*;
        let config = LoopConfig {
            max_agent_secs: 20 * 60,
            ..LoopConfig::default()
        };
        let mut interrupted = iteration(1, Interrupted, None);
        interrupted.counted = false;
        let iterations = [interrupted, iteration(2, Checked, Some("a"))];
        assert_eq!(verdict(&config, &iterations, None), Verdict::Iterate);
        let more = [iterations[1].clone(), iteration(3, Checked, Some("b"))];
        assert_eq!(verdict(&config, &more, None), Verdict::OutOfTime);
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
            maestro_protocol::AgentRole::Coder,
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
        assert!(
            !dir_path.join("tests").exists(),
            "the worker never sees the tests"
        );
        assert!(task.loop_sealed_sha.is_some());

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
            Some("added b"),
            false,
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
            assert_eq!((row.files, row.summary.as_deref()), (1, Some("added b")));
        }
        let committed = git(&dir, &["show", "--name-only", "--format=", "HEAD"])
            .await
            .unwrap();
        assert_eq!(committed.trim(), "src/b.txt");
        assert!(
            !dir_path.join("tests").exists(),
            "the sealed files are gone again"
        );
        assert!(!dir_path.join(SEALED_DIR).exists());
        let status = git(&dir, &["status", "--porcelain"]).await.unwrap();
        assert!(status.trim().is_empty(), "nothing left over: {status}");
    }

    #[tokio::test]
    async fn a_failing_check_hands_its_output_to_the_next_iteration() {
        let (_repo, store, task) = sealed_loop("git hash-object src/missing.txt").await;
        let (dir, task, iteration) = start(&store, &task).await;
        std::fs::write(Path::new(&dir).join("src/b.txt"), "b").unwrap();

        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(&store, &everyone, &path, &task, &iteration, None, false).await;

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
        let prompt = crate::task_prompt::compose(
            &conn,
            &path,
            &task,
            Some(TaskPhase::Iterating),
            maestro_protocol::AgentRole::Coder,
            None,
            None,
        )
        .unwrap()
        .embed();
        let text = prompt.blocks[1]["text"].as_str().unwrap();
        assert!(text.contains("## Iteration 2"), "{text}");
        assert!(text.contains("Sees the sealed files (failing)"), "{text}");
        assert!(text.contains("src/missing.txt"), "the output reaches it: {text}");
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
        finish(&store, &everyone, &path, &task, &iteration, None, false).await;

        let conn = store.lock().await;
        let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
        assert_eq!(row.outcome, LoopIterationOutcome::Failed);
        assert!(
            row.check_output.as_deref().unwrap_or_default().contains("lint says no"),
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
            maestro_protocol::AgentRole::Coder,
            None,
            None,
        )
        .unwrap()
        .embed();
        let text = prompt.blocks[1]["text"].as_str().unwrap();
        assert!(text.contains("lint says no"), "{text}");
    }

    #[tokio::test]
    async fn an_iteration_with_nothing_to_commit_runs_no_checks() {
        let (_repo, store, task) = sealed_loop(SEES_THEM).await;
        let (_dir, task, iteration) = start(&store, &task).await;
        let everyone = crate::client_sink::ClientSink::detached();
        let path = task.project_path.clone();
        finish(&store, &everyone, &path, &task, &iteration, None, false).await;

        let conn = store.lock().await;
        let row = &loops::list_iterations(&conn, &path, task.id).unwrap()[0];
        assert_eq!(row.outcome, LoopIterationOutcome::Empty);
        let check = &loops::list_checks(&conn, &path, task.id).unwrap()[0];
        assert_eq!(check.state, LoopCheckState::Pending);
    }
}
