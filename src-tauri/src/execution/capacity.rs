//! How many agents a host can run at once.
//!
//! The limit is per host rather than per project, because it tracks real resources: two projects
//! pointed at the same SSH box share that box's memory, and nothing in the frontend can see that —
//! which is why the scheduler has to live here rather than in the UI.
//!
//! The user picks between a fixed number and a figure derived from free memory. Neither is a
//! guess about the other: a laptop with plenty of RAM but a noisy fan wants a hard cap, and a
//! shared build host wants the limit to move as other people use it.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A running agent measures at 250–300 MB. 400 gives headroom for the outliers without being so
/// generous that a 16 GB machine is told it can run four things.
pub const MB_PER_AGENT: u64 = 400;

/// Left for the operating system and whatever else the user is doing. Scheduling into the last
/// gigabyte is how a machine starts swapping while the board reports everything is fine.
pub const RESERVED_MB: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "PascalCase")]
pub enum ConcurrencyMode {
    /// The number the user set, regardless of what the host is doing.
    #[default]
    Hard,
    /// Derived from the host's free memory, recomputed whenever the queue is drained.
    Auto,
}

impl std::str::FromStr for ConcurrencyMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Hard" => Ok(ConcurrencyMode::Hard),
            "Auto" => Ok(ConcurrencyMode::Auto),
            other => Err(format!("Unknown concurrency mode: {}", other)),
        }
    }
}

impl ConcurrencyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ConcurrencyMode::Hard => "Hard",
            ConcurrencyMode::Auto => "Auto",
        }
    }
}

/// The number of agents `available_mb` of free memory supports.
///
/// Floors at zero rather than clamping to one, and that is deliberate: a host with nothing spare
/// should stop draining the queue. Manual Execute is unaffected — a dynamic limit warns rather
/// than refuses, so the user can still start something on a machine they know is fine.
pub fn slots_for_memory(available_mb: u64) -> i32 {
    let spare = available_mb.saturating_sub(RESERVED_MB);
    (spare / MB_PER_AGENT).min(i32::MAX as u64) as i32
}

/// The limit in force for a host, and why.
///
/// `reason` is not decoration. A queue that has silently stopped moving is the failure mode this
/// whole design keeps running into, so the board has to be able to say *"0 slots — 1.2 GB free"*
/// rather than simply doing nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct HostCapacity {
    pub slots: i32,
    pub mode: ConcurrencyMode,
    pub reason: String,
}

/// Resolve the limit for a host.
///
/// `available_mb` is `None` when the host could not be measured — a remote we have no memory
/// probe for, or a probe that failed. That falls back to the configured number rather than
/// refusing to schedule: a host that works should not stop working because we cannot introspect
/// it, and reporting zero would look identical to a stalled queue.
pub fn resolve_capacity(
    mode: ConcurrencyMode,
    configured: i32,
    available_mb: Option<u64>,
) -> HostCapacity {
    match (mode, available_mb) {
        (ConcurrencyMode::Hard, _) => HostCapacity {
            slots: configured.max(0),
            mode: ConcurrencyMode::Hard,
            reason: format!("Fixed limit of {}", configured.max(0)),
        },
        (ConcurrencyMode::Auto, Some(available_mb)) => {
            let slots = slots_for_memory(available_mb);
            HostCapacity {
                slots,
                mode: ConcurrencyMode::Auto,
                reason: if slots == 0 {
                    format!(
                        "No capacity — {:.1} GB free, {:.1} GB reserved for the system",
                        available_mb as f64 / 1024.0,
                        RESERVED_MB as f64 / 1024.0
                    )
                } else {
                    format!("{} from {:.1} GB free", slots, available_mb as f64 / 1024.0)
                },
            }
        }
        (ConcurrencyMode::Auto, None) => HostCapacity {
            slots: configured.max(0),
            mode: ConcurrencyMode::Hard,
            reason: format!(
                "Memory could not be read on this host — using the fixed limit of {}",
                configured.max(0)
            ),
        },
    }
}

/// Available memory on this machine, in MB.
///
/// `sysinfo` rather than a hand-rolled probe per platform: the three calls involved are
/// `GlobalMemoryStatusEx`, `host_statistics64` and `/proc/meminfo`, and owning that unsafe code to
/// save one dependency is a poor trade. Only the `system` feature is enabled, which costs three
/// crates, two of them platform-gated.
///
/// Refreshes RAM alone. The default refresh walks processes, disks and networks, which is a
/// meaningful cost to pay on every drain for a number that is one field.
fn local_available_memory_mb() -> u64 {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};

    let system = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
    );

    system.available_memory() / (1024 * 1024)
}

/// Read available memory in MB on the host that will run the agents, or `None` when it cannot be
/// determined.
///
/// Remote hosts are asked for `MemAvailable` from `/proc/meminfo`, which covers Linux and WSL. It
/// is deliberately not `MemFree`: that excludes reclaimable page cache and would size a busy host
/// at nearly zero. A remote macOS host has no `/proc`, and a container's real ceiling is its cgroup
/// limit rather than the host's free memory — both return `None` and take the fixed limit.
pub async fn available_memory_mb(conn: &crate::models::GitConnection) -> Option<u64> {
    if matches!(conn, crate::models::GitConnection::Local { .. }) {
        return Some(local_available_memory_mb());
    }

    let output =
        crate::connectivity::exec_channel::run_on(conn, None, "cat", &["/proc/meminfo"]).await.ok()?;

    if !output.success() {
        return None;
    }

    parse_mem_available_kb(&output.stdout_string()).map(|kb| kb / 1024)
}

/// Pull `MemAvailable` out of `/proc/meminfo`, in kB.
fn parse_mem_available_kb(meminfo: &str) -> Option<u64> {
    meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from the design: 5 GB free runs 10 agents.
    #[test]
    fn five_gigabytes_free_runs_ten_agents() {
        assert_eq!(slots_for_memory(5 * 1024), 10);
    }

    #[test]
    fn the_reserve_comes_off_the_top() {
        // Exactly the reserve, and nothing beyond it.
        assert_eq!(slots_for_memory(RESERVED_MB), 0);
        assert_eq!(slots_for_memory(RESERVED_MB + MB_PER_AGENT - 1), 0);
        assert_eq!(slots_for_memory(RESERVED_MB + MB_PER_AGENT), 1);
    }

    /// A machine under memory pressure must not be talked into one more agent by arithmetic that
    /// clamps upward.
    #[test]
    fn a_host_with_nothing_spare_gets_no_slots() {
        for available in [0, 100, 900, 1023] {
            assert_eq!(slots_for_memory(available), 0, "for {} MB", available);
        }
    }

    /// `capacity_for_project` skips the memory probe entirely in this mode, so "ignores memory" has
    /// to mean the measured and unmeasured answers are the *same value*, not merely that both name
    /// the configured limit. Probing a remote host costs an exec, and the callers do it on every
    /// board event.
    #[test]
    fn a_hard_limit_ignores_memory_entirely() {
        let capacity = resolve_capacity(ConcurrencyMode::Hard, 4, Some(64 * 1024));
        assert_eq!(capacity.slots, 4);
        assert_eq!(capacity.mode, ConcurrencyMode::Hard);
        assert_eq!(
            capacity,
            resolve_capacity(ConcurrencyMode::Hard, 4, None),
            "the probe may only be skipped while these agree"
        );
    }

    /// The fallback that keeps a working host working. Reporting zero here would be
    /// indistinguishable from a stalled queue, which is the failure this design keeps hitting.
    #[test]
    fn an_unmeasurable_host_falls_back_to_the_fixed_limit() {
        let capacity = resolve_capacity(ConcurrencyMode::Auto, 3, None);
        assert_eq!(capacity.slots, 3);
        assert_eq!(capacity.mode, ConcurrencyMode::Hard, "the UI must not claim this was measured");
        assert!(capacity.reason.contains("could not be read"), "{}", capacity.reason);
    }

    /// A queue that stopped moving has to say why, or it looks broken.
    #[test]
    fn no_capacity_explains_itself() {
        let capacity = resolve_capacity(ConcurrencyMode::Auto, 3, Some(1200));
        assert_eq!(capacity.slots, 0);
        assert!(capacity.reason.contains("1.2 GB free"), "{}", capacity.reason);
    }

    /// A negative stored value would otherwise become a negative slot count and read as
    /// "unlimited" to any caller comparing against a running total.
    #[test]
    fn a_nonsense_configured_limit_cannot_go_negative() {
        assert_eq!(resolve_capacity(ConcurrencyMode::Hard, -5, None).slots, 0);
    }

    /// `MemFree` sits right above `MemAvailable` and is the wrong line: it excludes reclaimable
    /// cache, so a busy host would look empty.
    #[test]
    fn meminfo_parsing_takes_mem_available_not_mem_free() {
        let meminfo = "MemTotal:       16316360 kB\n\
                       MemFree:          204532 kB\n\
                       MemAvailable:    5242880 kB\n\
                       Buffers:          123456 kB\n";

        assert_eq!(parse_mem_available_kb(meminfo), Some(5242880));
        assert_eq!(slots_for_memory(parse_mem_available_kb(meminfo).unwrap() / 1024), 10);
    }

    /// `sysinfo` reports bytes, `/proc/meminfo` reports kB, and this function returns MB — three
    /// units for one number, and being wrong by 1024 sizes the farm at either zero agents or
    /// thousands.
    ///
    /// Each bound catches a specific regression rather than being decorative. The floor catches
    /// `sysinfo` going back to kB, which it reported before 0.30: an 8 GB machine would come out
    /// as 8. The ceiling catches the division being dropped: the same machine would come out as
    /// 8.6 billion. Neither bound can catch every possible slip on every machine, but these are
    /// the two ways this has actually gone wrong.
    #[test]
    fn local_memory_is_reported_in_megabytes() {
        let mb = local_available_memory_mb();

        assert!(
            (16..2_097_152).contains(&mb),
            "{} MB is not a plausible amount of free memory — check the unit conversion",
            mb
        );
    }

    #[test]
    fn meminfo_parsing_reports_nothing_it_cannot_read() {
        assert_eq!(parse_mem_available_kb(""), None);
        assert_eq!(parse_mem_available_kb("MemFree: 204532 kB\n"), None);
        assert_eq!(parse_mem_available_kb("MemAvailable:    not-a-number kB\n"), None);
    }
}
