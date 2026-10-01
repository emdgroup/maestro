//! The queue's driver: starts a project's ready tasks with no window open.
//!
//! A port of the app's `drain_ready_queue` and the `useQueueDrain` loop around it. A drain reads the
//! project's candidates (deferrals always, every queued task in auto mode), drops the held ones, and
//! claims them in order as coders until the machine's slots are full. Drains are debounced per
//! project and never overlap for one project; across projects the slot count is taken under one
//! lock, since the limit is the machine's and two drains must not both see the same free slot.
//!
//! A slot is a live task session in the map, which only the main loop holds, so a drain asks the
//! loop for it (`Snapshot`). Starts this scheduler launched that are not in the map yet are counted
//! in `IN_FLIGHT`, so a drain cannot overshoot while its own spawns are still coming up.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use maestro_protocol::{
    AgentRole, ListQueueCandidatesRequest, ServerRequest, ServerResponse, StartTaskRequest, Task,
};
use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};

use crate::agent::registry::DiscoveredAgentWithSpawn;
use crate::automations::canonical_project_path;
use crate::helpers::{broadcast, send_diag};

/// Long enough to collapse the burst of pushes one transition makes.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// Catches what no push announces: a hold lapsing, memory freeing up under `Auto`.
const TICK: Duration = Duration::from_secs(60);

/// What only the main loop knows, asked for once per drain.
pub(crate) struct Snapshot {
    pub used: usize,
    pub agents: Vec<DiscoveredAgentWithSpawn>,
}

pub(crate) type SnapshotRx = mpsc::Receiver<oneshot::Sender<Snapshot>>;

pub(crate) struct Deps {
    pub store: crate::project_store::Store,
    pub agent_connections: crate::sessions::SharedAgentConnections,
    pub settle_tx: crate::dispatch::SettleTx,
    pub stdout: crate::ClientOut,
}

enum Msg {
    Request(String),
    All,
    Due(String),
    Done(String),
}

static TX: OnceLock<mpsc::UnboundedSender<Msg>> = OnceLock::new();
/// Starts claimed by a drain whose session is not in the map yet.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
/// Taken while a drain counts and claims slots.
static RESERVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Tasks refused for want of an agent (none, or one unknown here), as they stood when refused, so
/// the tick does not file the same note every minute. One is tried again once it is written or
/// leaves the queue, or a user releases a hold on it. Execute still starts it directly.
static REFUSED: LazyLock<Mutex<HashMap<(String, i32), Task>>> = LazyLock::new(Default::default);

fn refused() -> std::sync::MutexGuard<'static, HashMap<(String, i32), Task>> {
    REFUSED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ask for a drain of the project. A no-op until the scheduler runs.
pub fn request_drain(project_path: &str) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Request(canonical_project_path(project_path)));
    }
}

/// Ask for a drain of every project with a candidate.
pub(crate) fn request_all() {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::All);
    }
}

/// A push about to go out: a task write or a settings change can add a candidate or a slot.
pub(crate) fn observe(push: &ServerResponse) {
    match push {
        ServerResponse::TasksChanged(project) => request_drain(&project.project_path),
        ServerResponse::PipelineSettingsChanged(changed) => match &changed.project_path {
            Some(path) => request_drain(path),
            None => request_all(),
        },
        _ => {}
    }
}

/// A hold taken or released. A release drains now; a hold drains once it could have lapsed.
pub(crate) fn hold_changed(request: &ServerRequest) {
    if TX.get().is_none() {
        return;
    }
    match request {
        ServerRequest::ReleaseTaskHold(r) => {
            let path = canonical_project_path(&r.project_path);
            refused().remove(&(path.clone(), r.task_id));
            request_drain(&path);
        }
        ServerRequest::HoldTask(r) => {
            let path = canonical_project_path(&r.project_path);
            let task_id = r.task_id;
            let ttl = r
                .ttl_ms
                .map_or(crate::pipeline_settings::HOLD_TTL, Duration::from_millis);
            tokio::spawn(async move {
                tokio::time::sleep(ttl + Duration::from_millis(50)).await;
                if !crate::pipeline_settings::is_held(&path, task_id) {
                    request_drain(&path);
                }
            });
        }
        _ => {}
    }
}

/// Run the scheduler. The returned receiver is the main loop's: answer each with a `Snapshot`.
pub(crate) fn start(deps: Deps) -> SnapshotRx {
    let (tx, rx) = mpsc::unbounded_channel();
    let (snapshot_tx, snapshot_rx) = mpsc::channel(8);
    if TX.set(tx.clone()).is_ok() {
        tokio::spawn(run(Arc::new(deps), snapshot_tx, tx, rx));
    }
    snapshot_rx
}

/// One project's debounce and overlap state.
#[derive(Default, Debug, PartialEq)]
struct Slot {
    armed: bool,
    running: bool,
    again: bool,
}

#[derive(Debug, PartialEq)]
enum Step {
    Nothing,
    Arm,
    Run,
}

impl Slot {
    fn requested(&mut self) -> Step {
        if self.running {
            self.again = true;
            Step::Nothing
        } else if self.armed {
            Step::Nothing
        } else {
            self.armed = true;
            Step::Arm
        }
    }

    fn due(&mut self) -> Step {
        self.armed = false;
        if self.running {
            self.again = true;
            Step::Nothing
        } else {
            self.running = true;
            Step::Run
        }
    }

    fn done(&mut self) -> Step {
        self.running = false;
        if std::mem::take(&mut self.again) {
            self.armed = true;
            Step::Arm
        } else {
            Step::Nothing
        }
    }

    fn idle(&self) -> bool {
        *self == Slot::default()
    }
}

async fn run(
    deps: Arc<Deps>,
    snapshot_tx: mpsc::Sender<oneshot::Sender<Snapshot>>,
    tx: mpsc::UnboundedSender<Msg>,
    mut rx: mpsc::UnboundedReceiver<Msg>,
) {
    let mut slots: HashMap<String, Slot> = HashMap::new();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + TICK, TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let msg = tokio::select! {
            _ = tick.tick() => Msg::All,
            msg = rx.recv() => match msg {
                Some(msg) => msg,
                None => return,
            },
        };
        let (path, step) = match msg {
            Msg::All => {
                let projects = projects_with_candidates(&*deps.store.lock().await);
                for path in projects.unwrap_or_default() {
                    let _ = tx.send(Msg::Request(path));
                }
                continue;
            }
            Msg::Request(path) => {
                let step = slots.entry(path.clone()).or_default().requested();
                (path, step)
            }
            Msg::Due(path) => {
                let step = slots.entry(path.clone()).or_default().due();
                (path, step)
            }
            Msg::Done(path) => {
                let step = slots.entry(path.clone()).or_default().done();
                (path, step)
            }
        };
        match step {
            Step::Nothing => {}
            Step::Arm => {
                let tx = tx.clone();
                let path = path.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(DEBOUNCE).await;
                    let _ = tx.send(Msg::Due(path));
                });
            }
            Step::Run => {
                let (tx, deps, snapshot_tx, path) = (
                    tx.clone(),
                    Arc::clone(&deps),
                    snapshot_tx.clone(),
                    path.clone(),
                );
                tokio::spawn(async move {
                    drain(&deps, &snapshot_tx, &path).await;
                    let _ = tx.send(Msg::Done(path));
                });
            }
        }
        if slots.get(&path).is_some_and(Slot::idle) {
            slots.remove(&path);
        }
    }
}

fn projects_with_candidates(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT DISTINCT project_path FROM tasks WHERE status = 'Queue' AND phase IS NULL")
        .map_err(|e| format!("Failed to prepare query: {e}"))?;
    let paths = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("Failed to list queued projects: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read queued projects: {e}"));
    paths
}

/// The tasks a drain may start, best first: auto mode decides whether undeferred tasks count,
/// and a held or refused task is left alone.
fn candidates(conn: &Connection, project_path: &str) -> Result<Vec<i32>, String> {
    let request = ListQueueCandidatesRequest {
        project_path: project_path.to_string(),
        include_undeferred: crate::pipeline_settings::auto_mode(conn, project_path)?,
    };
    let queued = crate::task_store::queue_candidates(conn, &request)?;
    let mut refused = refused();
    refused.retain(|(path, id), seen| {
        path != project_path
            || (queued.contains(id)
                && crate::task_store::get(conn, path, *id)
                    .ok()
                    .flatten()
                    .as_ref()
                    == Some(seen))
    });
    Ok(queued
        .into_iter()
        .filter(|&id| {
            !crate::pipeline_settings::is_held(project_path, id)
                && !refused.contains_key(&(project_path.to_string(), id))
        })
        .collect())
}

/// Slots left once live sessions and starts still coming up are counted.
fn free_slots(capacity: i32, used: usize, in_flight: usize) -> usize {
    (capacity.max(0) as usize).saturating_sub(used + in_flight)
}

async fn drain(deps: &Deps, snapshot_tx: &mpsc::Sender<oneshot::Sender<Snapshot>>, path: &str) {
    let found = candidates(&*deps.store.lock().await, path);
    let candidates = match found {
        Ok(candidates) if candidates.is_empty() => return,
        Ok(candidates) => candidates,
        Err(e) => {
            send_diag(
                "warn",
                format!("[queue] cannot read the queue of {path}: {e}"),
            );
            return;
        }
    };

    let _reserve = RESERVE.lock().await;
    let (reply_tx, reply_rx) = oneshot::channel();
    if snapshot_tx.send(reply_tx).await.is_err() {
        return;
    }
    let Ok(Snapshot { used, mut agents }) = reply_rx.await else {
        return;
    };
    crate::agent::registry::apply_custom_agents(&mut agents);

    let mut pushes = Vec::new();
    let mut claimed = Vec::new();
    {
        let mut conn = deps.store.lock().await;
        let capacity = match crate::pipeline_settings::capacity_status(&conn) {
            Ok(status) => status,
            Err(e) => {
                send_diag("warn", format!("[queue] cannot read the agent limit: {e}"));
                return;
            }
        };
        let mut free = free_slots(capacity.slots, used, IN_FLIGHT.load(Ordering::SeqCst));
        for task_id in candidates {
            if free == 0 {
                break;
            }
            let request = StartTaskRequest {
                project_path: path.to_string(),
                task_id,
                role: AgentRole::Coder,
                feedback: None,
                unattended: true,
                // Counted above, against every slot on the machine.
                respect_capacity: false,
                agent_id: None,
            };
            match crate::task_runner::begin(&mut conn, &request, used, &agents, &mut pushes) {
                Ok(crate::task_runner::Begun::Claimed(task)) => {
                    free -= 1;
                    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
                    claimed.push(task);
                }
                Ok(crate::task_runner::Begun::Deferred) => {}
                Err(e) => {
                    if let crate::task_runner::NotBegun::NoAgent(_) = e {
                        if let Ok(Some(task)) = crate::task_store::get(&conn, path, task_id) {
                            refused().insert((path.to_string(), task_id), task);
                        }
                    }
                    send_diag("info", format!("[queue] task {task_id} not started: {e}"));
                }
            }
        }
    }
    for push in pushes {
        broadcast(&deps.stdout, push).await;
    }
    for task in claimed {
        let reply = crate::client_sink::ClientSink::for_client(&deps.stdout, u64::MAX).await;
        let launcher = crate::task_runner::Launcher {
            store: Arc::clone(&deps.store),
            agent_connections: Arc::clone(&deps.agent_connections),
            settle_tx: deps.settle_tx.clone(),
            reply,
        };
        tokio::spawn(async move {
            Box::pin(crate::task_runner::launch(launcher, task)).await;
            // The session is handed to the loop before `launch` returns, and the loop takes it
            // before it answers the next snapshot.
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{AutoModeSetting, BranchMode, CreateTaskRequest, WorkspaceMode};

    fn queued(conn: &mut Connection, project: &str, title: &str, deferred: bool) -> i32 {
        let task = crate::task_store::create(
            conn,
            &CreateTaskRequest {
                project_path: project.to_string(),
                title: title.to_string(),
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
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'Queue', execute_requested_at = ?3
             WHERE project_path = ?1 AND id = ?2",
            rusqlite::params![
                project,
                task.id,
                deferred.then(|| "2026-01-01T00:00:00Z".to_string())
            ],
        )
        .unwrap();
        task.id
    }

    #[test]
    fn candidates_follow_auto_mode_holds_and_refusals() {
        let project = canonical_project_path("/srv/scheduler-test");
        let mut conn = crate::project_store::open_in_memory();
        let plain = queued(&mut conn, &project, "plain", false);
        let deferred = queued(&mut conn, &project, "deferred", true);
        let held = queued(&mut conn, &project, "held", true);
        crate::pipeline_settings::answer_hold(ServerRequest::HoldTask(
            maestro_protocol::HoldTaskRequest {
                project_path: project.clone(),
                task_id: held,
                ttl_ms: None,
            },
        ))
        .unwrap();

        // Manual mode starts deferrals only.
        assert_eq!(candidates(&conn, &project).unwrap(), vec![deferred]);

        crate::pipeline_settings::answer(
            &conn,
            ServerRequest::SetAutoMode(AutoModeSetting {
                project_path: project.clone(),
                enabled: true,
            }),
        )
        .unwrap();
        assert_eq!(candidates(&conn, &project).unwrap(), vec![deferred, plain]);

        let seen = crate::task_store::get(&conn, &project, deferred)
            .unwrap()
            .unwrap();
        refused().insert((project.clone(), deferred), seen);
        assert_eq!(candidates(&conn, &project).unwrap(), vec![plain]);
        // A write to the task tries it again.
        conn.execute(
            "UPDATE tasks SET agent_id = 'other' WHERE project_path = ?1 AND id = ?2",
            rusqlite::params![project, deferred],
        )
        .unwrap();
        assert_eq!(candidates(&conn, &project).unwrap(), vec![deferred, plain]);
        assert!(!refused().contains_key(&(project.clone(), deferred)));
        assert_eq!(
            projects_with_candidates(&conn).unwrap(),
            vec![project.clone()]
        );
    }

    #[test]
    fn starts_still_coming_up_take_a_slot() {
        assert_eq!(free_slots(3, 1, 0), 2);
        assert_eq!(free_slots(3, 1, 1), 1);
        assert_eq!(free_slots(3, 2, 2), 0);
        assert_eq!(free_slots(-1, 0, 0), 0);
    }

    #[test]
    fn drains_are_debounced_and_never_overlap() {
        let mut slot = Slot::default();
        assert_eq!(slot.requested(), Step::Arm);
        // A burst collapses into the one armed timer.
        assert_eq!(slot.requested(), Step::Nothing);
        assert_eq!(slot.due(), Step::Run);
        // Asked again mid-drain: remembered, not run alongside.
        assert_eq!(slot.requested(), Step::Nothing);
        assert_eq!(slot.requested(), Step::Nothing);
        assert_eq!(slot.done(), Step::Arm);
        assert_eq!(slot.due(), Step::Run);
        assert_eq!(slot.done(), Step::Nothing);
        assert!(slot.idle());
    }
}
