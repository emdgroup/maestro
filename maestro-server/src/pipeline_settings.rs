//! What the scheduler reads before it starts a task: how many agents this machine may run, whether
//! a project's queued tasks start on their own, and which tasks a user is holding.
//!
//! Capacity is the machine's, not an app's: every app attached to this daemon shares it, and in
//! `Auto` it is measured here, on the machine the agents run on. Auto mode is the project's. Both
//! are rows in `projects.db`. Holds are in memory and die with the daemon, which is the point: a
//! hold that outlived a crash would keep a task off the queue with nothing to explain it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use maestro_protocol::{
    AutoModeSetting, CapacitySettings, CapacityStatus, ConcurrencyMode, PipelineSettingsChanged,
    ServerRequest, ServerResponse,
};
use rusqlite::{params, Connection, OptionalExtension};

use crate::automations::canonical_project_path;
use crate::sessions::{ProjectBinding, SessionMap};

/// Version 6 of `projects.db`: the machine's capacity and each project's auto mode. Frozen: a later
/// change is a new entry in `project_store::MIGRATIONS`.
pub const V6_PIPELINE_SETTINGS: &str = "
CREATE TABLE IF NOT EXISTS machine_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    concurrency_mode TEXT NOT NULL,
    max_concurrent_agents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_settings (
    project_path TEXT PRIMARY KEY,
    auto_mode INTEGER NOT NULL DEFAULT 0
);
";

/// A running agent measures at 250-300 MB; 400 leaves room for the outliers.
const MB_PER_AGENT: u64 = 400;
/// Left for the operating system and whatever else the machine is doing.
const RESERVED_MB: u64 = 1024;
/// How long a hold survives unrenewed when the client names no TTL.
const HOLD_TTL: Duration = Duration::from_secs(10);

const DEFAULT_CAPACITY: CapacitySettings = CapacitySettings {
    concurrency_mode: ConcurrencyMode::Auto,
    max_concurrent_agents: 3,
};

pub fn capacity(conn: &Connection) -> Result<CapacitySettings, String> {
    let row = conn
        .query_row(
            "SELECT concurrency_mode, max_concurrent_agents FROM machine_settings WHERE id = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read the agent limit: {e}"))?;
    Ok(match row {
        Some((mode, max_concurrent_agents)) => CapacitySettings {
            concurrency_mode: if mode == "Hard" {
                ConcurrencyMode::Hard
            } else {
                ConcurrencyMode::Auto
            },
            max_concurrent_agents,
        },
        None => DEFAULT_CAPACITY,
    })
}

fn set_capacity(conn: &Connection, settings: &CapacitySettings) -> Result<(), String> {
    let mode = match settings.concurrency_mode {
        ConcurrencyMode::Hard => "Hard",
        ConcurrencyMode::Auto => "Auto",
    };
    conn.execute(
        "INSERT INTO machine_settings (id, concurrency_mode, max_concurrent_agents)
         VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET concurrency_mode = ?1, max_concurrent_agents = ?2",
        params![mode, settings.max_concurrent_agents],
    )
    .map(|_| ())
    .map_err(|e| format!("Failed to save the agent limit: {e}"))
}

/// Whether the project's queued tasks start on their own. Off until a client turns it on.
pub fn auto_mode(conn: &Connection, project_path: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT auto_mode FROM project_settings WHERE project_path = ?1",
        params![project_path],
        |row| row.get(0),
    )
    .optional()
    .map(|enabled| enabled.unwrap_or(false))
    .map_err(|e| format!("Failed to read auto mode: {e}"))
}

fn set_auto_mode(conn: &Connection, project_path: &str, enabled: bool) -> Result<(), String> {
    conn.execute(
        "INSERT INTO project_settings (project_path, auto_mode) VALUES (?1, ?2)
         ON CONFLICT(project_path) DO UPDATE SET auto_mode = ?2",
        params![project_path, enabled],
    )
    .map(|_| ())
    .map_err(|e| format!("Failed to save auto mode: {e}"))
}

/// The number of agents `available_mb` of free memory supports. Floors at zero: a machine with
/// nothing spare stops draining the queue.
fn slots_for_memory(available_mb: u64) -> i32 {
    let spare = available_mb.saturating_sub(RESERVED_MB);
    (spare / MB_PER_AGENT).min(i32::MAX as u64) as i32
}

/// The limit in force and why, worded as the app words it. `available_mb` is `None` when the
/// machine could not be measured, which falls back to the configured number.
fn resolve(settings: CapacitySettings, available_mb: Option<u64>) -> CapacityStatus {
    let configured = settings.max_concurrent_agents.max(0);
    let (slots, reason) = match (settings.concurrency_mode, available_mb) {
        (ConcurrencyMode::Hard, _) => (configured, format!("Fixed limit of {configured}")),
        (ConcurrencyMode::Auto, Some(available_mb)) => {
            let slots = slots_for_memory(available_mb);
            let free = available_mb as f64 / 1024.0;
            let reason = if slots == 0 {
                format!(
                    "No capacity: {free:.1} GB free, {:.1} GB reserved for the system",
                    RESERVED_MB as f64 / 1024.0
                )
            } else {
                format!("{slots} from {free:.1} GB free")
            };
            (slots, reason)
        }
        (ConcurrencyMode::Auto, None) => (
            configured,
            format!("Memory could not be read on this host, using the fixed limit of {configured}"),
        ),
    };
    CapacityStatus {
        settings,
        slots,
        reason,
    }
}

/// Available memory on this machine in MB, `None` where `sysinfo` cannot read it. The same probe
/// the app ran for a local project; the daemon is always local to its agents.
fn available_memory_mb() -> Option<u64> {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    let system = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    (system.total_memory() > 0).then(|| system.available_memory() / (1024 * 1024))
}

/// The machine's limit right now. Measures memory only in `Auto`, where the answer uses it.
pub fn capacity_status(conn: &Connection) -> Result<CapacityStatus, String> {
    let settings = capacity(conn)?;
    let available_mb = match settings.concurrency_mode {
        ConcurrencyMode::Hard => None,
        ConcurrencyMode::Auto => available_memory_mb(),
    };
    Ok(resolve(settings, available_mb))
}

/// Slots taken: live sessions bound to a task. A task at a human gate whose session has gone
/// takes none.
pub fn used_slots(sessions: &SessionMap) -> usize {
    count_task_sessions(sessions.values().map(|s| s.project.as_ref()))
}

fn count_task_sessions<'a>(bindings: impl Iterator<Item = Option<&'a ProjectBinding>>) -> usize {
    bindings
        .filter(|binding| binding.is_some_and(|b| b.meta.task_id.is_some()))
        .count()
}

// ponytail: process-wide map rather than main-loop state, one daemon per machine makes them the same.
static HOLDS: LazyLock<Mutex<HashMap<(String, i32), Instant>>> = LazyLock::new(Default::default);

fn holds() -> std::sync::MutexGuard<'static, HashMap<(String, i32), Instant>> {
    let mut holds = HOLDS.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    holds.retain(|_, expires_at| *expires_at > now);
    holds
}

/// Take or renew a hold. `project_path` is canonical.
fn hold(project_path: &str, task_id: i32, ttl: Duration) {
    holds().insert((project_path.to_string(), task_id), Instant::now() + ttl);
}

fn release(project_path: &str, task_id: i32) {
    holds().remove(&(project_path.to_string(), task_id));
}

/// Whether a user is working with the task, so the scheduler leaves it alone. `project_path` is
/// canonical.
#[allow(dead_code)] // D4's scheduler is the caller.
pub fn is_held(project_path: &str, task_id: i32) -> bool {
    holds().contains_key(&(project_path.to_string(), task_id))
}

/// Answer a hold request, which needs no store.
pub fn answer_hold(request: ServerRequest) -> Result<ServerResponse, String> {
    match request {
        ServerRequest::HoldTask(r) => {
            let ttl = r.ttl_ms.map_or(HOLD_TTL, Duration::from_millis);
            hold(&canonical_project_path(&r.project_path), r.task_id, ttl);
            Ok(ServerResponse::HoldTaskOk)
        }
        ServerRequest::ReleaseTaskHold(r) => {
            release(&canonical_project_path(&r.project_path), r.task_id);
            Ok(ServerResponse::ReleaseTaskHoldOk)
        }
        _ => Err("not a hold request".to_string()),
    }
}

/// The reply to a capacity or auto mode request, and the pushes to broadcast after it.
pub fn answer(
    conn: &Connection,
    request: ServerRequest,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    let changed = |project_path| {
        vec![ServerResponse::PipelineSettingsChanged(
            PipelineSettingsChanged { project_path },
        )]
    };
    match request {
        ServerRequest::GetCapacity => Ok((
            ServerResponse::GetCapacityOk(capacity_status(conn)?),
            Vec::new(),
        )),
        ServerRequest::SetCapacity(settings) => {
            set_capacity(conn, &settings)?;
            Ok((ServerResponse::SetCapacityOk, changed(None)))
        }
        ServerRequest::GetAutoMode(r) => {
            let project_path = canonical_project_path(&r.project_path);
            let enabled = auto_mode(conn, &project_path)?;
            Ok((
                ServerResponse::AutoModeOk(AutoModeSetting {
                    project_path,
                    enabled,
                }),
                Vec::new(),
            ))
        }
        ServerRequest::SetAutoMode(r) => {
            let project_path = canonical_project_path(&r.project_path);
            set_auto_mode(conn, &project_path, r.enabled)?;
            Ok((ServerResponse::SetAutoModeOk, changed(Some(project_path))))
        }
        _ => Err("not a pipeline settings request".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{HoldTaskRequest, ProjectRef, SessionMeta, TaskRef};

    #[test]
    fn an_unset_machine_measures_memory_with_three_as_the_fallback() {
        let conn = crate::project_store::open_in_memory();
        assert_eq!(capacity(&conn).unwrap(), DEFAULT_CAPACITY);
    }

    #[test]
    fn capacity_is_stored_and_announced() {
        let conn = crate::project_store::open_in_memory();
        let hard = CapacitySettings {
            concurrency_mode: ConcurrencyMode::Hard,
            max_concurrent_agents: 5,
        };
        let (_, pushes) = answer(&conn, ServerRequest::SetCapacity(hard)).unwrap();
        assert_eq!(
            pushes,
            vec![ServerResponse::PipelineSettingsChanged(
                PipelineSettingsChanged { project_path: None }
            )]
        );
        let (reply, _) = answer(&conn, ServerRequest::GetCapacity).unwrap();
        let ServerResponse::GetCapacityOk(status) = reply else {
            panic!("not a capacity");
        };
        assert_eq!(status.settings, hard);
        assert_eq!(status.slots, 5);
        assert_eq!(status.reason, "Fixed limit of 5");
    }

    #[test]
    fn auto_mode_is_per_project_and_off_until_set() {
        let conn = crate::project_store::open_in_memory();
        let get = |path: &str| match answer(
            &conn,
            ServerRequest::GetAutoMode(ProjectRef {
                project_path: path.to_string(),
            }),
        )
        .unwrap()
        .0
        {
            ServerResponse::AutoModeOk(setting) => setting.enabled,
            other => panic!("{other:?}"),
        };
        assert!(!get("/srv/shop"));
        let (_, pushes) = answer(
            &conn,
            ServerRequest::SetAutoMode(AutoModeSetting {
                project_path: "/srv/shop".to_string(),
                enabled: true,
            }),
        )
        .unwrap();
        assert_eq!(
            pushes,
            vec![ServerResponse::PipelineSettingsChanged(
                PipelineSettingsChanged {
                    project_path: Some(canonical_project_path("/srv/shop"))
                }
            )]
        );
        assert!(get("/srv/shop"));
        assert!(!get("/srv/other"));
    }

    #[test]
    fn memory_sizes_the_limit_after_the_reserve() {
        assert_eq!(slots_for_memory(5 * 1024), 10);
        assert_eq!(slots_for_memory(RESERVED_MB + MB_PER_AGENT - 1), 0);
        assert_eq!(slots_for_memory(RESERVED_MB + MB_PER_AGENT), 1);
        let status = resolve(DEFAULT_CAPACITY, Some(1200));
        assert_eq!(status.slots, 0);
        assert!(status.reason.contains("1.2 GB free"), "{}", status.reason);
        let status = resolve(DEFAULT_CAPACITY, None);
        assert_eq!(status.slots, 3);
        assert!(
            status.reason.contains("could not be read"),
            "{}",
            status.reason
        );
        let hard = CapacitySettings {
            concurrency_mode: ConcurrencyMode::Hard,
            max_concurrent_agents: -5,
        };
        assert_eq!(resolve(hard, Some(64 * 1024)).slots, 0);
    }

    /// `sysinfo` reports bytes; off by 1024 sizes the machine at zero agents or thousands.
    #[test]
    fn local_memory_is_reported_in_megabytes() {
        let mb = available_memory_mb().expect("this machine can be measured");
        assert!((16..2_097_152).contains(&mb), "{mb} MB is not plausible");
    }

    #[test]
    fn only_sessions_with_a_task_take_a_slot() {
        let binding = |task_id| ProjectBinding {
            project_path: "/srv/shop".to_string(),
            meta: SessionMeta {
                task_id,
                ..SessionMeta::default()
            },
            can_reload: true,
            requested_at: chrono::Utc::now(),
        };
        let (task, chat) = (binding(Some(3)), binding(None));
        assert_eq!(
            count_task_sessions([Some(&task), Some(&chat), None].into_iter()),
            1
        );
    }

    #[test]
    fn a_hold_keeps_the_task_until_released_or_lapsed() {
        let path = "/srv/holds-test";
        let held = |task_id| is_held(&canonical_project_path(path), task_id);
        answer_hold(ServerRequest::HoldTask(HoldTaskRequest {
            project_path: path.to_string(),
            task_id: 1,
            ttl_ms: None,
        }))
        .unwrap();
        assert!(held(1));
        assert!(!held(2), "another task is not held");
        answer_hold(ServerRequest::ReleaseTaskHold(TaskRef {
            project_path: path.to_string(),
            task_id: 1,
        }))
        .unwrap();
        assert!(!held(1));

        // Lapsed, then renewed.
        hold(&canonical_project_path(path), 4, Duration::ZERO);
        assert!(!held(4));
        hold(&canonical_project_path(path), 4, HOLD_TTL);
        assert!(held(4));
    }
}
